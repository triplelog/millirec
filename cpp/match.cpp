// match.cpp — the millirec point-cloud matcher.
//
// A shape is a cloud of points, each stored as 5 doubles: x, y (centred and
// scale-normalised by the caller), sin and cos of the stroke direction at the
// point, and an optional curvature feature. Two clouds are compared by building
// a cost matrix over every pair of points,
//
//     cost = min(maxCost, (alpha*turn + beta*dist^2 + kappaGamma*|dkappa|)^2)
//
// (turn = squared chord between the two unit direction vectors, folded so that
// opposite directions count as equal), padding it with `outliers` free rows and
// columns so a few points may stay unmatched, and solving the assignment
// problem on it (assign.cpp). A class is scored from its best two templates.
//
// Templates live in pointsMap, one slot per (class, sample):
// slot = class*shapesPerChar + sample. The query is either testMap (slot -1,
// read by identify/getTestScore) or an ordinary slot (the batch entry points).
//
// Builds: emscripten + embind (see EMSCRIPTEN_BINDINGS at the end;
// -DMILLIREC_LITE binds only the single-character surface), or natively with
// -DMATCH_NO_MAIN and an #include, for sanitizer and brute-force tests.
//
// The entry points trust their caller. The single-character surface
// (firstCall, addPoint*, identify, identifyBatch, getTestScore) checks its
// arguments; the batch/cascade surface below it does not check slot indices.
#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#include <emscripten/val.h>
using namespace emscripten;
#endif
#include "assign.cpp"
#include <vector>
#include <algorithm>
#include <cmath>
#include <cstdint>
#if defined(__EMSCRIPTEN__) && defined(__EMSCRIPTEN_PTHREADS__)
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <functional>
#endif


int ppsMap;
int shapesPerChar;
int nchars;
double alpha;
double beta;
double maxCost;
double divi;
double outlierCost;
double kappaGamma = 0; // weight of the |kappa1-kappa2| curvature term (0 = off)
/** Cost gate. Every term of `inside2` is non-negative, so beta*ddis alone
 *  reaching sqrt(maxCost) already forces (inside2)^2 past maxCost: such a pair
 *  can be written as maxCost WITHOUT computing orientation or curvature, and
 *  the matrix is bit-identical. gateRadT is that distance^2 threshold and
 *  gateAxisT its per-axis form (a cheaper pre-test). ~64% of real pairs clear
 *  it and ~79% end up capped anyway.
 *  gateScale < 1 shrinks the radius BELOW the provable bound — pairs that
 *  would not have capped get written as maxCost, trading accuracy for speed.
 *  gateScale = 1 is exact; 0 disables the gate entirely. */
/** gateMode selects the rejection shape, implemented purely by thresholds so
 *  no extra branch is introduced: 0 = square pre-test then circle (default),
 *  1 = square only (one branch, looser — a square contains its circle),
 *  2 = circle only (skips the 4 axis compares; ddis is needed anyway). */
int gateOn = 0;
int gateMode = 0;
double gateAxisT = 1e300;
double gateRadT = 1e300;
double gateScale = 1.0;
int scoreMode = 0;
double totalMin[2];
std::vector<std::vector<double> > pointsMap;
std::vector<double> testMap;
std::vector<int> spcMap;

// Solver selection: 0 = exact LAP (default), 2 = max-regret matching. Declared
// here because entry points on both sides of the implementation consult it.
static int gSolver = 0;
static double regretMatch(double** cm, int n, int needM, bool dropWorst);



/** Recompute the gate thresholds. Exactness at gateScale=1 needs every cost
 *  term non-negative, so the gate is disabled if any weight is negative. */
static void recomputeGate(){
	if (beta > 0 && maxCost > 0 && alpha >= 0 && kappaGamma >= 0 && gateScale > 0) {
		gateOn = 1;
		double ddisCap = (sqrt(maxCost) / beta) * gateScale * gateScale;
		gateRadT  = (gateMode == 1) ? 1e300 : ddisCap;
		gateAxisT = (gateMode == 2) ? 1e300 : sqrt(ddisCap);
	} else {
		gateOn = 0;
		gateAxisT = 1e300;
		gateRadT = 1e300;
	}
}

/** Outlier rows/columns for a match at `pps` points: pps*outliersMul/10, never
 *  negative (a negative count made the matrix smaller than pps and the fill
 *  wrote past it). */
static inline int outlierCount(int pps, int outliersMul) {
	int o = pps*outliersMul/10;
	return o > 0 ? o : 0;
}
/** Is `slot` a template slot firstCall allocated? */
static inline bool slotOK(int slot) {
	return slot >= 0 && slot < (int)pointsMap.size();
}

extern "C" {
/** Top three classes of a recognition: class index, class score, and the slot
 *  id of the class's best template (identify) or its sample index
 *  (identifyBatch). A rank with no class keeps its initial values. */
struct ArrayInStruct {
	int char1;
	int char2;
	int char3;
	int sid1;
	int sid2;
	int sid3;
	double value1;
	double value2;
	double value3;

};

ArrayInStruct identify(int digit, int sid, int pointsPerShape, bool train, int outliersMul, int nots1) {
	int i; int j; double result; int ati = 0; int s1i;
	int ii;
	double xx1; double yy1;
	double xx2; double yy2;
	double x1; double y1;
	double x2; double y2;
	double ddis; double inside1; double inside2;
	// testMap holds ppsMap points, so a match cannot use more than that (it
	// used to read past the end); fewer than 0 is no match at all.
	if (pointsPerShape > ppsMap) pointsPerShape = ppsMap;
	if (pointsPerShape < 0) pointsPerShape = 0;
	int outliers = outlierCount(pointsPerShape, outliersMul);
	if (train){
		outliers = 0;
	}

	double innerMax = maxCost*pointsPerShape/divi;
	// Stored templates have ppsMap points; matching may use fewer. Map the
	// i-th of pointsPerShape evenly onto 0..ppsMap-1 (endpoints included) —
	// the old `skips = ppsMap/pointsPerShape+1` stride overran the vector
	// whenever pointsPerShape < ppsMap.
	int mapMax = ppsMap - 1;
	int mapDen = pointsPerShape > 1 ? pointsPerShape - 1 : 1;

	double absMin[2];
	absMin[0] = 10000000;
	absMin[1] = 10000000;

	ArrayInStruct output;
	output.sid1 = output.sid2 = output.sid3 = -1; // stay -1 when fewer than 3 classes score
	double minResult[3][2];
	for (i=0;i<3;i++){
		minResult[i][0] = 1000000;
		minResult[i][1] = 1000000;
	}

	int dim = pointsPerShape+outliers;
	double** costMatrix;
	int *rowsol;
	int *colsol;
	double *u;
	double *v;
	rowsol = new int[dim];
	colsol = new int[dim];
	u = new double[dim];
	v = new double[dim];
	costMatrix = new double*[dim];
	for (i=0;i<dim;i++){
		rowsol[i]=i;
		colsol[i]=i;
		u[i]=0;
		v[i]=0;
		costMatrix[i] = new double[dim];
	}

	if (nots1 == -1 && slotOK(digit*shapesPerChar+sid)){
		for (j=0;j<pointsPerShape;j++){
			i = j*mapMax/mapDen;
			testMap[j*5+0] = pointsMap[digit*shapesPerChar+sid][i*5+0];
			testMap[j*5+1] = pointsMap[digit*shapesPerChar+sid][i*5+1];
			testMap[j*5+2] = pointsMap[digit*shapesPerChar+sid][i*5+2];
			testMap[j*5+3] = pointsMap[digit*shapesPerChar+sid][i*5+3];
			testMap[j*5+4] = pointsMap[digit*shapesPerChar+sid][i*5+4];
		}
		nots1 = digit*shapesPerChar+sid;
	}

	for (ati=0;ati<nchars;ati++){
		double maxValue[8] = {1000000,1000000,1000000,1000000,1000000,1000000,1000000,1000000};
		for (s1i=0;s1i<spcMap[ati];s1i++){
			int s1 = ati*shapesPerChar+s1i;
			if (s1 == nots1){
				continue;
			}

			for (i=0;i<dim;i++){
				rowsol[i]=i;
				colsol[i]=i;
				u[i]=0;
				v[i]=0;
			}
			
			double bestCostSum = 0;
			double bestCost = maxCost;
			for(i=0; i<pointsPerShape; i++) {
				ii = i*mapMax/mapDen;
				y1 = pointsMap[s1][ii*5+2];
				x1 = pointsMap[s1][ii*5+3];
				xx1 = pointsMap[s1][ii*5+0];
				yy1 = pointsMap[s1][ii*5+1];
				double k1 = pointsMap[s1][ii*5+4];
				bestCost = maxCost;
				for(j=0; j<pointsPerShape; j++) {
					xx2 = testMap[j*5+0]-xx1;
					yy2 = testMap[j*5+1]-yy1;
					// gated pairs are exactly the ones the cap would produce,
					// and bestCost starts at maxCost so it needs no update
					if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
							yy2 > gateAxisT || yy2 < -gateAxisT)) {
						costMatrix[i][j] = maxCost;
						continue;
					}
					ddis = xx2*xx2+yy2*yy2;
					if (gateOn && ddis >= gateRadT) {
						costMatrix[i][j] = maxCost;
						continue;
					}

					y2 = testMap[j*5+2]-y1;
					x2 = testMap[j*5+3]-x1;
					inside1 = y2*y2+x2*x2;

					if (inside1 > 2){
						inside1 = 4-inside1;
					}

					double kdiff = testMap[j*5+4]-k1;
					if (kdiff < 0) kdiff = -kdiff;
					inside2 = inside1 * alpha + ddis * beta + kdiff * kappaGamma;
					inside1 = inside2*inside2;
					if ( inside1 > maxCost){
						costMatrix[i][j] = maxCost;
					}
					else {
						costMatrix[i][j] = inside1;
						if (inside1 < bestCost){
							bestCost = inside1;
						}
					}
					
				}
				bestCostSum += bestCost;


				if (bestCostSum > innerMax){
					break;
				}
			}

			if (bestCostSum > innerMax){
				continue;
			}

			for (i=pointsPerShape;i<pointsPerShape+outliers;i++){
				for (j=0;j<pointsPerShape+outliers;j++){
					costMatrix[i][j] = outlierCost;
				}
			}
			for (i=0;i<pointsPerShape+outliers;i++){
				for (j=pointsPerShape;j<pointsPerShape+outliers;j++){
					costMatrix[i][j] = outlierCost;
				}
			}
			
			
			
			double cost = lapOutliers(dim, costMatrix, rowsol, colsol, u, v, outliers, outlierCost);

			// Normalise by sequence continuity: one plus the number of
			// consecutive template points whose partners are within 3 places of
			// each other, so an order-preserving match divides by more.
			int denom = 1;
			if (train){
				denom = dim;
			}
			else {
				for (i=0;i<dim-1;i++){
					if ((rowsol[i+1]-rowsol[i])*(rowsol[i+1]-rowsol[i]) < 10){
						denom += 1;
					}
				}
			}

			
			result = cost / denom;

			// maxValue: [0],[1],[4],[5] = the class's four lowest results,
			// [2],[3],[6],[7] = the slots they came from
			if (result < maxValue[0]){
				maxValue[7] = maxValue[6];
				maxValue[6] = maxValue[3];
				maxValue[5] = maxValue[4];
				maxValue[4] = maxValue[1];
				maxValue[1] = maxValue[0];
				maxValue[3] = maxValue[2];
				maxValue[0] = result;
				maxValue[2] = s1;
			}
			else if (result < maxValue[1]){
				maxValue[7] = maxValue[6];
				maxValue[6] = maxValue[3];
				maxValue[5] = maxValue[4];
				maxValue[4] = maxValue[1];
				maxValue[1] = result;
				maxValue[3] = s1;
			}
			else if (result < maxValue[4]){
				maxValue[7] = maxValue[6];
				maxValue[5] = maxValue[4];
				maxValue[4] = result;
				maxValue[6] = s1;
			}
			else if (result < maxValue[5]){
				maxValue[5] = result;
				maxValue[7] = s1;
			}
			
		}
		
		// Class score combines the class's top template matches. Any missing
		// term (single training sample, or templates skipped by the innerMax
		// early exit) substitutes best with a 0.9 penalty per substitution —
		// mode 0 with one sample reduces to the 0.9*best^3 fallback.
		// scoreMode (setScoreMode, default 0):
		//   0  best^2 * 2nd            (historical)
		//   1  best^3                  (top-1 only)
		//   2  best^2 * 3rd
		//   3  best * 2nd * 3rd
		double best = maxValue[0];
		double v2 = maxValue[1];
		double v3 = maxValue[4];
		double factor = 1;
		if ((scoreMode == 0 || scoreMode == 3) && v2 >= 1000000){ v2 = best; factor *= 0.9; }
		if ((scoreMode == 2 || scoreMode == 3) && v3 >= 1000000){ v3 = best; factor *= 0.9; }
		double classScore;
		if (scoreMode == 1){ classScore = best*best*best; }
		else if (scoreMode == 2){ classScore = factor*best*best*v3; }
		else if (scoreMode == 3){ classScore = factor*best*v2*v3; }
		else { classScore = factor*best*best*v2; }
		if (classScore < minResult[0][0]){
			minResult[2][0] = minResult[1][0];
			minResult[2][1] = minResult[1][1];
			minResult[1][0] = minResult[0][0];
			minResult[1][1] = minResult[0][1];
			minResult[0][0] = classScore;
			minResult[0][1] = ati;
			output.sid3 = output.sid2;
			output.sid2 = output.sid1;
			output.sid1 = maxValue[2];

		}
		else if (classScore < minResult[1][0]){
			minResult[2][0] = minResult[1][0];
			minResult[2][1] = minResult[1][1];
			minResult[1][0] = classScore;
			minResult[1][1] = ati;
			output.sid3 = output.sid2;
			output.sid2 = maxValue[2];

		}
		else if (classScore < minResult[2][0]){
			minResult[2][0] = classScore;
			minResult[2][1] = ati;
			output.sid3 = maxValue[2];
		}
		if (maxValue[0] < absMin[0]){
			absMin[0] = maxValue[0];
		}
		else if (maxValue[0] < absMin[1]){
			absMin[1] = maxValue[0];
		}
	}
	for (i=0;i<dim;i++){
		delete[] costMatrix[i];
	}
	delete[] costMatrix;
	costMatrix = NULL;
	delete[] rowsol;
	delete[] colsol;
	delete[] u;
	delete[] v;
	rowsol = NULL;
	colsol = NULL;
	u = NULL;
	v = NULL;
	output.char1 = (int) minResult[0][1];
	output.char2 = (int) minResult[1][1];
	output.char3 = (int) minResult[2][1];
	output.value1 = minResult[0][0];
	output.value2 = minResult[1][0];
	output.value3 = minResult[2][0];
	totalMin[0] += absMin[0]/260;
	totalMin[1] += absMin[1]/260;
	return output;
	  
};

double getSingleScore(int test_digit, int test_sid, int template_digit, int template_sid, int pointsPerShape, int outliersMul) {
	int i; int j;
	int outliers = outlierCount(pointsPerShape, outliersMul);
	int dim = pointsPerShape+outliers;
	double** costMatrix;
	int *rowsol;
	int *colsol;
	double *u;
	double *v;
	rowsol = new int[dim];
	colsol = new int[dim];
	u = new double[dim];
	v = new double[dim];
	costMatrix = new double*[dim];
	for (i=0;i<dim;i++){
		rowsol[i]=i;
		colsol[i]=i;
		u[i]=0;
		v[i]=0;
		costMatrix[i] = new double[dim];
	}

	double a1; double xx1; double yy1;
	double xx2; double yy2;
	double x1;
	double x2; double y2;

	int test_idx = test_digit * shapesPerChar + test_sid;
	int temp_idx = template_digit * shapesPerChar + template_sid;

	// Same even subsampling of stored points as identify().
	int mapMax = ppsMap - 1;
	int mapDen = pointsPerShape > 1 ? pointsPerShape - 1 : 1;

	for(i=0; i<pointsPerShape; i++) {
		int im = i*mapMax/mapDen;
		a1 = pointsMap[temp_idx][im*5+2];
		xx1 = pointsMap[temp_idx][im*5+0];
		yy1 = pointsMap[temp_idx][im*5+1];
		x1 = pointsMap[temp_idx][im*5+3];
		double k1 = pointsMap[temp_idx][im*5+4];
		for(j=0; j<pointsPerShape; j++) {
			int jm = j*mapMax/mapDen;
			xx2 = pointsMap[test_idx][jm*5+0]-xx1;
			yy2 = pointsMap[test_idx][jm*5+1]-yy1;
			if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
					yy2 > gateAxisT || yy2 < -gateAxisT)) {
				costMatrix[i][j] = maxCost;
				continue;
			}
			double ddis = xx2*xx2+yy2*yy2;
			if (gateOn && ddis >= gateRadT) {
				costMatrix[i][j] = maxCost;
				continue;
			}

			y2 = pointsMap[test_idx][jm*5+2]-a1;
			x2 = pointsMap[test_idx][jm*5+3]-x1;
			double inside1 = y2*y2+x2*x2;

			if (inside1 > 2){
				inside1 = 4-inside1;
			}

			double kdiff = pointsMap[test_idx][jm*5+4]-k1;
			if (kdiff < 0) kdiff = -kdiff;
			double inside2 = inside1 * alpha + ddis * beta + kdiff * kappaGamma;
			inside1 = inside2*inside2;
			if ( inside1 > maxCost){
				costMatrix[i][j] = maxCost;
			}
			else {
				costMatrix[i][j] = inside1;
			}
		}
	}

	for (i=pointsPerShape;i<pointsPerShape+outliers;i++){
		for (j=0;j<pointsPerShape+outliers;j++){
			costMatrix[i][j] = outlierCost;
		}
	}
	for (i=0;i<pointsPerShape+outliers;i++){
		for (j=pointsPerShape;j<pointsPerShape+outliers;j++){
			costMatrix[i][j] = outlierCost;
		}
	}

	double cost = lapOutliers(dim, costMatrix, rowsol, colsol, u, v, outliers, outlierCost);

	int denom = dim;

	double result = cost / denom;

	for (i=0;i<dim;i++){
		delete[] costMatrix[i];
	}
	delete[] costMatrix;
	delete[] rowsol;
	delete[] colsol;
	delete[] u;
	delete[] v;

	return result;
}
#ifdef __EMSCRIPTEN__
/** Batch getSingleScore: score ONE uploaded test slot against a LIST of
 *  template slots (linear indices digit*shapesPerChar+sid) in a single
 *  JS↔WASM crossing. The cost matrix, solver workspace, and the test slot's
 *  subsampled points are allocated/read ONCE and reused for every template —
 *  getSingleScore rebuilds all of it per call. Returns a JS array of
 *  cost/dim values in the same order as `slots`. Math is identical to
 *  getSingleScore (same subsampling, same denom = dim). */
emscripten::val getScoresBatch(int test_digit, int test_sid, int pointsPerShape, int outliersMul, emscripten::val slots) {
	std::vector<int> slotList = emscripten::vecFromJSArray<int>(slots);
	int i; int j;
	int outliers = outlierCount(pointsPerShape, outliersMul);
	int dim = pointsPerShape+outliers;
	double** costMatrix = new double*[dim];
	int *rowsol = new int[dim];
	int *colsol = new int[dim];
	double *u = new double[dim];
	double *v = new double[dim];
	for (i=0;i<dim;i++){
		rowsol[i]=i; colsol[i]=i; u[i]=0; v[i]=0;
		costMatrix[i] = new double[dim];
	}
	// outlier rows/cols never change across templates — fill once
	for (i=pointsPerShape;i<dim;i++)
		for (j=0;j<dim;j++) costMatrix[i][j] = outlierCost;
	for (i=0;i<dim;i++)
		for (j=pointsPerShape;j<dim;j++) costMatrix[i][j] = outlierCost;

	int test_idx = test_digit * shapesPerChar + test_sid;
	int mapMax = ppsMap - 1;
	int mapDen = pointsPerShape > 1 ? pointsPerShape - 1 : 1;
	// snapshot the test slot's subsampled points once
	std::vector<double> tp(pointsPerShape*5);
	for (j=0; j<pointsPerShape; j++) {
		int jm = j*mapMax/mapDen;
		for (int f=0; f<5; f++) tp[j*5+f] = pointsMap[test_idx][jm*5+f];
	}

	std::vector<double> results(slotList.size());
	for (size_t s = 0; s < slotList.size(); s++) {
		int temp_idx = slotList[s];
		// fresh solver state per template (bit-identical to getSingleScore)
		for (i=0;i<dim;i++){ rowsol[i]=i; colsol[i]=i; u[i]=0; v[i]=0; }
		for(i=0; i<pointsPerShape; i++) {
			int im = i*mapMax/mapDen;
			double a1 = pointsMap[temp_idx][im*5+2];
			double xx1 = pointsMap[temp_idx][im*5+0];
			double yy1 = pointsMap[temp_idx][im*5+1];
			double x1 = pointsMap[temp_idx][im*5+3];
			double k1 = pointsMap[temp_idx][im*5+4];
			for(j=0; j<pointsPerShape; j++) {
				double xx2 = tp[j*5+0]-xx1;
				double yy2 = tp[j*5+1]-yy1;
				if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
						yy2 > gateAxisT || yy2 < -gateAxisT)) {
					costMatrix[i][j] = maxCost;
					continue;
				}
				double ddis = xx2*xx2+yy2*yy2;
				if (gateOn && ddis >= gateRadT) {
					costMatrix[i][j] = maxCost;
					continue;
				}
				double y2 = tp[j*5+2]-a1;
				double x2 = tp[j*5+3]-x1;
				double inside1 = y2*y2+x2*x2;
				if (inside1 > 2) inside1 = 4-inside1;
				double kdiff = tp[j*5+4]-k1;
				if (kdiff < 0) kdiff = -kdiff;
				double inside2 = inside1 * alpha + ddis * beta + kdiff * kappaGamma;
				inside1 = inside2*inside2;
				costMatrix[i][j] = inside1 > maxCost ? maxCost : inside1;
			}
		}
		// gSolver is 0 (exact LAP) unless a caller explicitly opted into the
		// max-regret heuristic, so the golden path here is untouched.
		if (gSolver >= 2) {
			int needM = pointsPerShape - outliers; if (needM < 0) needM = 0;
			results[s] = (regretMatch(costMatrix, pointsPerShape, needM, gSolver == 3)
			              + outlierCost * (dim - needM)) / dim;
		} else {
			results[s] = lapOutliers(dim, costMatrix, rowsol, colsol, u, v, outliers, outlierCost) / dim;
		}
	}
	for (i=0;i<dim;i++) delete[] costMatrix[i];
	delete[] costMatrix;
	delete[] rowsol; delete[] colsol; delete[] u; delete[] v;

	emscripten::val out = emscripten::val::array();
	for (size_t s = 0; s < results.size(); s++) out.set(s, results[s]);
	return out;
}
/** Batch scoring with a LOWER-BOUND early exit. For each template, after the
 *  O(dim²) cost-matrix fill, compute a valid lower bound on the LAP cost:
 *  only `outliers` columns cost outlierCost and each absorbs at most one
 *  row, so any assignment pays at least the sum of the smallest
 *  (pps − outliers) per-row minima over REAL columns (the adversary parks
 *  the worst rows on outlier columns). Slots are grouped (parallel `groups`
 *  array, e.g. class ids); per group the two lowest EXACT costs are tracked,
 *  and when a template's bound already exceeds the group's second-best the
 *  O(dim³) solve is skipped — its entry returns −(bound) (negative marks a
 *  pruned slot; true cost is ≥ |value|). Exact for best²·2nd consumers:
 *  a pruned template provably cannot enter its group's best two. */
emscripten::val getScoresBatchPruned(int test_digit, int test_sid, int pointsPerShape, int outliersMul, emscripten::val slots, emscripten::val groups) {
	std::vector<int> slotList = emscripten::vecFromJSArray<int>(slots);
	std::vector<int> groupList = emscripten::vecFromJSArray<int>(groups);
	int i; int j;
	int outliers = outlierCount(pointsPerShape, outliersMul);
	int dim = pointsPerShape+outliers;
	double** costMatrix = new double*[dim];
	int *rowsol = new int[dim];
	int *colsol = new int[dim];
	double *u = new double[dim];
	double *v = new double[dim];
	for (i=0;i<dim;i++) costMatrix[i] = new double[dim];
	for (i=pointsPerShape;i<dim;i++)
		for (j=0;j<dim;j++) costMatrix[i][j] = outlierCost;
	for (i=0;i<dim;i++)
		for (j=pointsPerShape;j<dim;j++) costMatrix[i][j] = outlierCost;

	int test_idx = test_digit * shapesPerChar + test_sid;
	int mapMax = ppsMap - 1;
	int mapDen = pointsPerShape > 1 ? pointsPerShape - 1 : 1;
	std::vector<double> tp(pointsPerShape*5);
	for (j=0; j<pointsPerShape; j++) {
		int jm = j*mapMax/mapDen;
		for (int f=0; f<5; f++) tp[j*5+f] = pointsMap[test_idx][jm*5+f];
	}

	// per-group two lowest exact costs
	int maxGroup = 0;
	for (size_t s = 0; s < groupList.size(); s++) if (groupList[s] > maxGroup) maxGroup = groupList[s];
	std::vector<double> g1(maxGroup+1, 1e30), g2(maxGroup+1, 1e30);

	std::vector<double> rowMin(pointsPerShape);
	std::vector<double> results(slotList.size());
	for (size_t s = 0; s < slotList.size(); s++) {
		int temp_idx = slotList[s];
		int grp = s < groupList.size() ? groupList[s] : -1;
		double bound = 0;
		for(i=0; i<pointsPerShape; i++) {
			int im = i*mapMax/mapDen;
			double a1 = pointsMap[temp_idx][im*5+2];
			double xx1 = pointsMap[temp_idx][im*5+0];
			double yy1 = pointsMap[temp_idx][im*5+1];
			double x1 = pointsMap[temp_idx][im*5+3];
			double k1 = pointsMap[temp_idx][im*5+4];
			double rm = 1e30;
			for(j=0; j<pointsPerShape; j++) {
				double xx2 = tp[j*5+0]-xx1;
				double yy2 = tp[j*5+1]-yy1;
				if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
						yy2 > gateAxisT || yy2 < -gateAxisT)) {
					costMatrix[i][j] = maxCost;
					if (maxCost < rm) rm = maxCost;
					continue;
				}
				double ddis = xx2*xx2+yy2*yy2;
				if (gateOn && ddis >= gateRadT) {
					costMatrix[i][j] = maxCost;
					if (maxCost < rm) rm = maxCost;
					continue;
				}
				double y2 = tp[j*5+2]-a1;
				double x2 = tp[j*5+3]-x1;
				double inside1 = y2*y2+x2*x2;
				if (inside1 > 2) inside1 = 4-inside1;
				double kdiff = tp[j*5+4]-k1;
				if (kdiff < 0) kdiff = -kdiff;
				double inside2 = inside1 * alpha + ddis * beta + kdiff * kappaGamma;
				inside1 = inside2*inside2;
				double c = inside1 > maxCost ? maxCost : inside1;
				costMatrix[i][j] = c;
				if (c < rm) rm = c;
			}
			rowMin[i] = rm;
		}
		// bound = sum of the smallest (pps − outliers) row minima over real
		// columns (each free outlier column absorbs one worst row at oc)
		std::vector<double> rms(rowMin);
		std::sort(rms.begin(), rms.end());
		int payRows = pointsPerShape - outliers;
		if (payRows < 0) payRows = 0;
		for (i=0; i<payRows; i++) bound += rms[i];
		bound += outlierCost * outliers;
		double denomD = dim;
		if (grp >= 0 && bound/denomD >= g2[grp]) {
			results[s] = -(bound/denomD); // pruned: true cost ≥ |value|
			continue;
		}
		for (i=0;i<dim;i++){ rowsol[i]=i; colsol[i]=i; u[i]=0; v[i]=0; }
		double cost = lapOutliers(dim, costMatrix, rowsol, colsol, u, v, outliers, outlierCost) / denomD;
		results[s] = cost;
		if (grp >= 0) {
			if (cost < g1[grp]) { g2[grp] = g1[grp]; g1[grp] = cost; }
			else if (cost < g2[grp]) g2[grp] = cost;
		}
	}
	for (i=0;i<dim;i++) delete[] costMatrix[i];
	delete[] costMatrix;
	delete[] rowsol; delete[] colsol; delete[] u; delete[] v;

	emscripten::val out = emscripten::val::array();
	for (size_t s = 0; s < results.size(); s++) out.set(s, results[s]);
	return out;
}
/** GREEDY row-minimum scoring: every point takes its best partner
 *  independently, DUPLICATES ALLOWED. This is precisely the LAP lower bound
 *  getScoresBatchPruned computes for pruning, promoted to a score — the
 *  O(pps^2) fill with NO O(dim^3) solve and no solver workspace at all.
 *  Same outlier allowance (drop the worst `outliers` rows) and the same
 *  denom = dim as the other batch entry points, so values are comparable.
 *  It is a LOWER bound on the true assignment cost, so it can only flatter a
 *  template — a single template point may serve every test point. */
emscripten::val getScoresBatchGreedy(int test_digit, int test_sid, int pointsPerShape, int outliersMul, emscripten::val slots) {
	std::vector<int> slotList = emscripten::vecFromJSArray<int>(slots);
	int i; int j;
	int outliers = outlierCount(pointsPerShape, outliersMul);
	int dim = pointsPerShape+outliers;
	int payRows = pointsPerShape - outliers;
	if (payRows < 0) payRows = 0;
	std::vector<double> rowMin(pointsPerShape);

	int test_idx = test_digit * shapesPerChar + test_sid;
	int mapMax = ppsMap - 1;
	int mapDen = pointsPerShape > 1 ? pointsPerShape - 1 : 1;
	std::vector<double> tp(pointsPerShape*5);
	for (j=0; j<pointsPerShape; j++) {
		int jm = j*mapMax/mapDen;
		for (int f=0; f<5; f++) tp[j*5+f] = pointsMap[test_idx][jm*5+f];
	}

	std::vector<double> results(slotList.size());
	for (size_t s = 0; s < slotList.size(); s++) {
		int temp_idx = slotList[s];
		for(i=0; i<pointsPerShape; i++) {
			int im = i*mapMax/mapDen;
			double a1 = pointsMap[temp_idx][im*5+2];
			double xx1 = pointsMap[temp_idx][im*5+0];
			double yy1 = pointsMap[temp_idx][im*5+1];
			double x1 = pointsMap[temp_idx][im*5+3];
			double k1 = pointsMap[temp_idx][im*5+4];
			double rm = 1e30;
			for(j=0; j<pointsPerShape; j++) {
				double xx2 = tp[j*5+0]-xx1;
				double yy2 = tp[j*5+1]-yy1;
				if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
						yy2 > gateAxisT || yy2 < -gateAxisT)) {
					if (maxCost < rm) rm = maxCost;
					continue;
				}
				double ddis = xx2*xx2+yy2*yy2;
				if (gateOn && ddis >= gateRadT) {
					if (maxCost < rm) rm = maxCost;
					continue;
				}
				double y2 = tp[j*5+2]-a1;
				double x2 = tp[j*5+3]-x1;
				double inside1 = y2*y2+x2*x2;
				if (inside1 > 2) inside1 = 4-inside1;
				double kdiff = tp[j*5+4]-k1;
				if (kdiff < 0) kdiff = -kdiff;
				double inside2 = inside1 * alpha + ddis * beta + kdiff * kappaGamma;
				inside1 = inside2*inside2;
				double c = inside1 > maxCost ? maxCost : inside1;
				if (c < rm) rm = c;
			}
			rowMin[i] = rm;
		}
		std::vector<double> rms(rowMin);
		std::sort(rms.begin(), rms.end());
		double bound = 0;
		for (i=0; i<payRows; i++) bound += rms[i];
		bound += outlierCost * outliers;
		results[s] = bound / (double)dim;
	}
	emscripten::val out = emscripten::val::array();
	for (size_t s = 0; s < results.size(); s++) out.set(s, results[s]);
	return out;
}
/** GREEDY MATCHING: repeatedly take the cheapest remaining pair whose two
 *  endpoints are both still free, until (pps - outliers) rows are matched.
 *  Unlike getScoresBatchGreedy this yields a VALID one-to-one assignment, so
 *  it is an UPPER bound on the optimal LAP cost rather than a lower one, and
 *  should track LAP far more closely. Cost is the O(pps^2) fill plus one sort
 *  of the sub-cap pairs (O(E log E), E ~ 36% of pps^2 once the gate discards
 *  the rest) instead of the LAP's O(dim^3) augmenting-path solve.
 *  Pairs pinned at maxCost are never worth matching, so they are excluded
 *  from the candidate list; a row left unmatched pays maxCost. */
emscripten::val getScoresBatchGreedyMatch(int test_digit, int test_sid, int pointsPerShape, int outliersMul, emscripten::val slots) {
	std::vector<int> slotList = emscripten::vecFromJSArray<int>(slots);
	int i; int j;
	int outliers = outlierCount(pointsPerShape, outliersMul);
	int dim = pointsPerShape+outliers;
	int need = pointsPerShape - outliers;
	if (need < 0) need = 0;

	int test_idx = test_digit * shapesPerChar + test_sid;
	int mapMax = ppsMap - 1;
	int mapDen = pointsPerShape > 1 ? pointsPerShape - 1 : 1;
	std::vector<double> tp(pointsPerShape*5);
	for (j=0; j<pointsPerShape; j++) {
		int jm = j*mapMax/mapDen;
		for (int f=0; f<5; f++) tp[j*5+f] = pointsMap[test_idx][jm*5+f];
	}

	// (cost, row, col) packed; reused across templates to avoid reallocation
	std::vector<std::pair<double,int> > edges;
	edges.reserve((size_t)pointsPerShape*pointsPerShape);
	std::vector<unsigned char> usedR(pointsPerShape), usedC(pointsPerShape);

	std::vector<double> results(slotList.size());
	for (size_t s = 0; s < slotList.size(); s++) {
		int temp_idx = slotList[s];
		edges.clear();
		for(i=0; i<pointsPerShape; i++) {
			int im = i*mapMax/mapDen;
			double a1 = pointsMap[temp_idx][im*5+2];
			double xx1 = pointsMap[temp_idx][im*5+0];
			double yy1 = pointsMap[temp_idx][im*5+1];
			double x1 = pointsMap[temp_idx][im*5+3];
			double k1 = pointsMap[temp_idx][im*5+4];
			for(j=0; j<pointsPerShape; j++) {
				double xx2 = tp[j*5+0]-xx1;
				double yy2 = tp[j*5+1]-yy1;
				if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
						yy2 > gateAxisT || yy2 < -gateAxisT)) continue;
				double ddis = xx2*xx2+yy2*yy2;
				if (gateOn && ddis >= gateRadT) continue;
				double y2 = tp[j*5+2]-a1;
				double x2 = tp[j*5+3]-x1;
				double inside1 = y2*y2+x2*x2;
				if (inside1 > 2) inside1 = 4-inside1;
				double kdiff = tp[j*5+4]-k1;
				if (kdiff < 0) kdiff = -kdiff;
				double inside2 = inside1 * alpha + ddis * beta + kdiff * kappaGamma;
				inside1 = inside2*inside2;
				if (inside1 >= maxCost) continue; // capped pairs are never worth taking
				edges.push_back(std::make_pair(inside1, i*pointsPerShape + j));
			}
		}
		std::sort(edges.begin(), edges.end());
		for (i=0;i<pointsPerShape;i++) { usedR[i]=0; usedC[i]=0; }
		int made = 0;
		double total = 0;
		for (size_t e = 0; e < edges.size() && made < need; e++) {
			int r = edges[e].second / pointsPerShape;
			int c = edges[e].second % pointsPerShape;
			if (usedR[r] || usedC[c]) continue;
			usedR[r] = 1; usedC[c] = 1;
			total += edges[e].first;
			made++;
		}
		while (made < need) { total += maxCost; made++; } // rows with no free partner
		total += outlierCost * outliers;
		results[s] = total / (double)dim;
	}
	emscripten::val out = emscripten::val::array();
	for (size_t s = 0; s < results.size(); s++) out.set(s, results[s]);
	return out;
}
/** GLOBAL-REFERENCE batch scoring. Pass 1 solves ONE sample per group
 *  exactly (probing every class first gives the tightest global reference
 *  before any redundant work); pass 2 computes each remaining template's
 *  lower bound and only solves when bound < globalSecondBest·relax — a
 *  template provably worse than the global runner-up belongs to a losing
 *  class and its exact cost cannot matter. Pruned entries return −bound.
 *  Consequence: hopeless classes keep ONE exact cost (their probe) and
 *  bounds for the rest — classCombine falls back to 0.9·best³ there, an
 *  approximation only for classes already out of contention. */
emscripten::val getScoresBatchGlobalMatch(int test_digit, int test_sid, int pointsPerShape, int outliersMul, emscripten::val slots, emscripten::val groups, double relax) {
	std::vector<int> slotList = emscripten::vecFromJSArray<int>(slots);
	std::vector<int> groupList = emscripten::vecFromJSArray<int>(groups);
	int i; int j;
	int outliers = outlierCount(pointsPerShape, outliersMul);
	int dim = pointsPerShape+outliers;
	double** costMatrix = new double*[dim];
	int *rowsol = new int[dim];
	int *colsol = new int[dim];
	double *u = new double[dim];
	double *v = new double[dim];
	for (i=0;i<dim;i++) costMatrix[i] = new double[dim];
	for (i=pointsPerShape;i<dim;i++)
		for (j=0;j<dim;j++) costMatrix[i][j] = outlierCost;
	for (i=0;i<dim;i++)
		for (j=pointsPerShape;j<dim;j++) costMatrix[i][j] = outlierCost;

	int test_idx = test_digit * shapesPerChar + test_sid;
	int mapMax = ppsMap - 1;
	int mapDen = pointsPerShape > 1 ? pointsPerShape - 1 : 1;
	std::vector<double> tp(pointsPerShape*5);
	for (j=0; j<pointsPerShape; j++) {
		int jm = j*mapMax/mapDen;
		for (int f=0; f<5; f++) tp[j*5+f] = pointsMap[test_idx][jm*5+f];
	}

	double denomD = dim;
	double g1 = 1e30, g2 = 1e30;
	std::vector<double> rowMin(pointsPerShape);
	std::vector<double> results(slotList.size(), 0.0);

	// fill + bound for slot s; returns bound/denom
	auto fillAndBound = [&](int temp_idx) -> double {
		for(i=0; i<pointsPerShape; i++) {
			int im = i*mapMax/mapDen;
			double a1 = pointsMap[temp_idx][im*5+2];
			double xx1 = pointsMap[temp_idx][im*5+0];
			double yy1 = pointsMap[temp_idx][im*5+1];
			double x1 = pointsMap[temp_idx][im*5+3];
			double k1 = pointsMap[temp_idx][im*5+4];
			double rm = 1e30;
			for(j=0; j<pointsPerShape; j++) {
				double xx2 = tp[j*5+0]-xx1;
				double yy2 = tp[j*5+1]-yy1;
				if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
						yy2 > gateAxisT || yy2 < -gateAxisT)) {
					costMatrix[i][j] = maxCost;
					if (maxCost < rm) rm = maxCost;
					continue;
				}
				double ddis = xx2*xx2+yy2*yy2;
				if (gateOn && ddis >= gateRadT) {
					costMatrix[i][j] = maxCost;
					if (maxCost < rm) rm = maxCost;
					continue;
				}
				double y2 = tp[j*5+2]-a1;
				double x2 = tp[j*5+3]-x1;
				double inside1 = y2*y2+x2*x2;
				if (inside1 > 2) inside1 = 4-inside1;
				double kdiff = tp[j*5+4]-k1;
				if (kdiff < 0) kdiff = -kdiff;
				double inside2 = inside1 * alpha + ddis * beta + kdiff * kappaGamma;
				inside1 = inside2*inside2;
				double c = inside1 > maxCost ? maxCost : inside1;
				costMatrix[i][j] = c;
				if (c < rm) rm = c;
			}
			rowMin[i] = rm;
		}
		std::vector<double> rms(rowMin);
		std::sort(rms.begin(), rms.end());
		int payRows = pointsPerShape - outliers;
		if (payRows < 0) payRows = 0;
		double bound = 0;
		for (i=0; i<payRows; i++) bound += rms[i];
		bound += outlierCost * outliers;
		return bound / denomD;
	};
	// Same pruning structure, but survivors are scored by GREEDY MATCHING
	// instead of the LAP: repeatedly take the cheapest pair whose endpoints
	// are both free. ~5x cheaper per solve and empirically within noise of
	// optimal (87.88 vs 88.00 on EMNIST letters). Greedy is an UPPER bound on
	// the true cost, so the g2 reference it feeds is slightly loose — the
	// prune test then fires slightly LESS often, never wrongly.
	std::vector<std::pair<double,int> > edges;
	edges.reserve((size_t)pointsPerShape*pointsPerShape);
	std::vector<unsigned char> usedR(pointsPerShape), usedC(pointsPerShape);
	int needMatch = pointsPerShape - outliers;
	if (needMatch < 0) needMatch = 0;
	auto solveExact = [&]() -> double {
		edges.clear();
		for (i=0;i<pointsPerShape;i++)
			for (j=0;j<pointsPerShape;j++) {
				double c = costMatrix[i][j];
				if (c < maxCost) edges.push_back(std::make_pair(c, i*pointsPerShape + j));
			}
		std::sort(edges.begin(), edges.end());
		for (i=0;i<pointsPerShape;i++) { usedR[i]=0; usedC[i]=0; }
		int made = 0;
		double total = 0;
		for (size_t e = 0; e < edges.size() && made < needMatch; e++) {
			int r = edges[e].second / pointsPerShape;
			int cc = edges[e].second % pointsPerShape;
			if (usedR[r] || usedC[cc]) continue;
			usedR[r] = 1; usedC[cc] = 1;
			total += edges[e].first;
			made++;
		}
		while (made < needMatch) { total += maxCost; made++; }
		total += outlierCost * outliers;
		double cost = total / denomD;
		if (cost < g1) { g2 = g1; g1 = cost; }
		else if (cost < g2) g2 = cost;
		return cost;
	};

	// pass 1: probe the first slot of every group exactly
	int maxGroup = 0;
	for (size_t s = 0; s < groupList.size(); s++) if (groupList[s] > maxGroup) maxGroup = groupList[s];
	std::vector<char> probed(maxGroup+1, 0);
	std::vector<char> done(slotList.size(), 0);
	for (size_t s = 0; s < slotList.size(); s++) {
		int grp = s < groupList.size() ? groupList[s] : 0;
		if (grp >= 0 && !probed[grp]) {
			probed[grp] = 1;
			fillAndBound(slotList[s]);
			results[s] = solveExact();
			done[s] = 1;
		}
	}
	// pass 2: bound-gate the rest against the GLOBAL runner-up
	for (size_t s = 0; s < slotList.size(); s++) {
		if (done[s]) continue;
		double bound = fillAndBound(slotList[s]);
		if (bound >= g2 * relax) results[s] = -bound;
		else results[s] = solveExact();
	}
	for (i=0;i<dim;i++) delete[] costMatrix[i];
	delete[] costMatrix;
	delete[] rowsol; delete[] colsol; delete[] u; delete[] v;

	emscripten::val out = emscripten::val::array();
	for (size_t s = 0; s < results.size(); s++) out.set(s, results[s]);
	return out;
}
emscripten::val getScoresBatchGlobal(int test_digit, int test_sid, int pointsPerShape, int outliersMul, emscripten::val slots, emscripten::val groups, double relax) {
	std::vector<int> slotList = emscripten::vecFromJSArray<int>(slots);
	std::vector<int> groupList = emscripten::vecFromJSArray<int>(groups);
	int i; int j;
	int outliers = outlierCount(pointsPerShape, outliersMul);
	int dim = pointsPerShape+outliers;
	double** costMatrix = new double*[dim];
	int *rowsol = new int[dim];
	int *colsol = new int[dim];
	double *u = new double[dim];
	double *v = new double[dim];
	for (i=0;i<dim;i++) costMatrix[i] = new double[dim];
	for (i=pointsPerShape;i<dim;i++)
		for (j=0;j<dim;j++) costMatrix[i][j] = outlierCost;
	for (i=0;i<dim;i++)
		for (j=pointsPerShape;j<dim;j++) costMatrix[i][j] = outlierCost;

	int test_idx = test_digit * shapesPerChar + test_sid;
	int mapMax = ppsMap - 1;
	int mapDen = pointsPerShape > 1 ? pointsPerShape - 1 : 1;
	std::vector<double> tp(pointsPerShape*5);
	for (j=0; j<pointsPerShape; j++) {
		int jm = j*mapMax/mapDen;
		for (int f=0; f<5; f++) tp[j*5+f] = pointsMap[test_idx][jm*5+f];
	}

	double denomD = dim;
	double g1 = 1e30, g2 = 1e30;
	std::vector<double> rowMin(pointsPerShape);
	std::vector<double> results(slotList.size(), 0.0);

	// fill + bound for slot s; returns bound/denom
	auto fillAndBound = [&](int temp_idx) -> double {
		for(i=0; i<pointsPerShape; i++) {
			int im = i*mapMax/mapDen;
			double a1 = pointsMap[temp_idx][im*5+2];
			double xx1 = pointsMap[temp_idx][im*5+0];
			double yy1 = pointsMap[temp_idx][im*5+1];
			double x1 = pointsMap[temp_idx][im*5+3];
			double k1 = pointsMap[temp_idx][im*5+4];
			double rm = 1e30;
			for(j=0; j<pointsPerShape; j++) {
				double xx2 = tp[j*5+0]-xx1;
				double yy2 = tp[j*5+1]-yy1;
				if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
						yy2 > gateAxisT || yy2 < -gateAxisT)) {
					costMatrix[i][j] = maxCost;
					if (maxCost < rm) rm = maxCost;
					continue;
				}
				double ddis = xx2*xx2+yy2*yy2;
				if (gateOn && ddis >= gateRadT) {
					costMatrix[i][j] = maxCost;
					if (maxCost < rm) rm = maxCost;
					continue;
				}
				double y2 = tp[j*5+2]-a1;
				double x2 = tp[j*5+3]-x1;
				double inside1 = y2*y2+x2*x2;
				if (inside1 > 2) inside1 = 4-inside1;
				double kdiff = tp[j*5+4]-k1;
				if (kdiff < 0) kdiff = -kdiff;
				double inside2 = inside1 * alpha + ddis * beta + kdiff * kappaGamma;
				inside1 = inside2*inside2;
				double c = inside1 > maxCost ? maxCost : inside1;
				costMatrix[i][j] = c;
				if (c < rm) rm = c;
			}
			rowMin[i] = rm;
		}
		std::vector<double> rms(rowMin);
		std::sort(rms.begin(), rms.end());
		int payRows = pointsPerShape - outliers;
		if (payRows < 0) payRows = 0;
		double bound = 0;
		for (i=0; i<payRows; i++) bound += rms[i];
		bound += outlierCost * outliers;
		return bound / denomD;
	};
	auto solveExact = [&]() -> double {
		for (i=0;i<dim;i++){ rowsol[i]=i; colsol[i]=i; u[i]=0; v[i]=0; }
		double cost = lapOutliers(dim, costMatrix, rowsol, colsol, u, v, outliers, outlierCost) / denomD;
		if (cost < g1) { g2 = g1; g1 = cost; }
		else if (cost < g2) g2 = cost;
		return cost;
	};

	// pass 1: probe the first slot of every group exactly
	int maxGroup = 0;
	for (size_t s = 0; s < groupList.size(); s++) if (groupList[s] > maxGroup) maxGroup = groupList[s];
	std::vector<char> probed(maxGroup+1, 0);
	std::vector<char> done(slotList.size(), 0);
	for (size_t s = 0; s < slotList.size(); s++) {
		int grp = s < groupList.size() ? groupList[s] : 0;
		if (grp >= 0 && !probed[grp]) {
			probed[grp] = 1;
			fillAndBound(slotList[s]);
			results[s] = solveExact();
			done[s] = 1;
		}
	}
	// pass 2: bound-gate the rest against the GLOBAL runner-up
	for (size_t s = 0; s < slotList.size(); s++) {
		if (done[s]) continue;
		double bound = fillAndBound(slotList[s]);
		if (bound >= g2 * relax) results[s] = -bound;
		else results[s] = solveExact();
	}
	for (i=0;i<dim;i++) delete[] costMatrix[i];
	delete[] costMatrix;
	delete[] rowsol; delete[] colsol; delete[] u; delete[] v;

	emscripten::val out = emscripten::val::array();
	for (size_t s = 0; s < results.size(); s++) out.set(s, results[s]);
	return out;
}
#endif

#if defined(__EMSCRIPTEN__) && defined(__EMSCRIPTEN_PTHREADS__)
// ---------------------------------------------------------------------------
// pthreads batch scoring: a persistent pool + threaded variants of the two
// hot batch entry points. Semantics vs the single-threaded versions: solved
// entries are IDENTICAL; the prune reference is FIXED after the exact probe
// phase instead of tightening mid-pass, so the threaded versions prune a
// subset of what sequential would (never more) — deterministic regardless of
// scheduling, and never wrong. (thread headers included at file top —
// template headers can't live inside the extern "C" region)
static std::vector<std::thread> g_pool;
static std::mutex g_m;
static std::condition_variable g_cv, g_cvDone;
static std::function<void(int, int)> g_itemFn; // (itemIdx, scratchIdx)
static std::atomic<int> g_nextItem(0);
static int g_totalItems = 0;
static std::atomic<int> g_activeWorkers(0);
static int g_generation = 0;
static int g_nThreads = 0;

static void mtWorkerLoop(int tid) {
	int seenGen = 0;
	while (true) {
		{
			std::unique_lock<std::mutex> lk(g_m);
			g_cv.wait(lk, [&]{ return g_generation != seenGen; });
			seenGen = g_generation;
		}
		while (true) {
			int it = g_nextItem.fetch_add(1);
			if (it >= g_totalItems) break;
			g_itemFn(it, tid);
		}
		if (g_activeWorkers.fetch_sub(1) == 1) {
			std::lock_guard<std::mutex> lk(g_m);
			g_cvDone.notify_all();
		}
	}
}

void initThreads(int n) {
	if (g_nThreads > 0 || n <= 0) return;
	g_nThreads = n;
	for (int i = 0; i < n; i++) g_pool.emplace_back(mtWorkerLoop, i);
	for (auto &t : g_pool) t.detach();
}

static void runParallel(int items, const std::function<void(int, int)> &fn) {
	if (g_nThreads == 0 || items < 4) { for (int i = 0; i < items; i++) fn(i, g_nThreads); return; }
	{
		std::lock_guard<std::mutex> lk(g_m);
		g_itemFn = fn;
		g_totalItems = items;
		g_nextItem.store(0);
		g_activeWorkers.store(g_nThreads);
		g_generation++;
	}
	g_cv.notify_all();
	while (true) { // main thread participates (scratch index g_nThreads)
		int it = g_nextItem.fetch_add(1);
		if (it >= items) break;
		g_itemFn(it, g_nThreads);
	}
	std::unique_lock<std::mutex> lk(g_m);
	g_cvDone.wait(lk, []{ return g_activeWorkers.load() == 0; });
}

// per-thread solver scratch
struct MTScratch {
	int dim = 0;
	std::vector<std::vector<double>> cm;
	std::vector<double*> cmp;
	std::vector<int> rowsol, colsol;
	std::vector<double> u, v, rowMin;
	void ensure(int d, int pps) {
		if (dim == d) return;
		dim = d;
		cm.assign(d, std::vector<double>(d, 0.0));
		cmp.resize(d);
		for (int i = 0; i < d; i++) cmp[i] = cm[i].data();
		rowsol.resize(d); colsol.resize(d); u.resize(d); v.resize(d); rowMin.resize(pps);
	}
};

// fill scratch's matrix for (tp vs template temp_idx); returns bound/denom
static double mtFillBound(MTScratch &S, const std::vector<double> &tp, int temp_idx, int pps, int outliers) {
	int i, j;
	int dim = pps + outliers;
	for (i = pps; i < dim; i++) for (j = 0; j < dim; j++) S.cmp[i][j] = outlierCost;
	for (i = 0; i < dim; i++) for (j = pps; j < dim; j++) S.cmp[i][j] = outlierCost;
	int mapMax = ppsMap - 1;
	int mapDen = pps > 1 ? pps - 1 : 1;
	for (i = 0; i < pps; i++) {
		int im = i * mapMax / mapDen;
		double a1 = pointsMap[temp_idx][im*5+2];
		double xx1 = pointsMap[temp_idx][im*5+0];
		double yy1 = pointsMap[temp_idx][im*5+1];
		double x1 = pointsMap[temp_idx][im*5+3];
		double k1 = pointsMap[temp_idx][im*5+4];
		double rm = 1e30;
		for (j = 0; j < pps; j++) {
			double xx2 = tp[j*5+0]-xx1;
			double yy2 = tp[j*5+1]-yy1;
			if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
					yy2 > gateAxisT || yy2 < -gateAxisT)) {
				S.cmp[i][j] = maxCost;
				if (maxCost < rm) rm = maxCost;
				continue;
			}
			double ddis = xx2*xx2+yy2*yy2;
			if (gateOn && ddis >= gateRadT) {
				S.cmp[i][j] = maxCost;
				if (maxCost < rm) rm = maxCost;
				continue;
			}
			double y2 = tp[j*5+2]-a1;
			double x2 = tp[j*5+3]-x1;
			double inside1 = y2*y2+x2*x2;
			if (inside1 > 2) inside1 = 4-inside1;
			double kdiff = tp[j*5+4]-k1;
			if (kdiff < 0) kdiff = -kdiff;
			double inside2 = inside1 * alpha + ddis * beta + kdiff * kappaGamma;
			inside1 = inside2*inside2;
			double c = inside1 > maxCost ? maxCost : inside1;
			S.cmp[i][j] = c;
			if (c < rm) rm = c;
		}
		S.rowMin[i] = rm;
	}
	std::vector<double> rms(S.rowMin.begin(), S.rowMin.begin() + pps);
	std::sort(rms.begin(), rms.end());
	int payRows = pps - outliers;
	if (payRows < 0) payRows = 0;
	double bound = 0;
	for (i = 0; i < payRows; i++) bound += rms[i];
	bound += outlierCost * outliers;
	return bound / dim;
}
static double mtSolve(MTScratch &S, int pps, int outliers) {
	int dim = pps + outliers;
	for (int i = 0; i < dim; i++) { S.rowsol[i]=i; S.colsol[i]=i; S.u[i]=0; S.v[i]=0; }
	return lapOutliers(dim, S.cmp.data(), S.rowsol.data(), S.colsol.data(), S.u.data(), S.v.data(), outliers, outlierCost) / (double)dim;
}

static void mtSnapshotTest(std::vector<double> &tp, int test_digit, int test_sid, int pps) {
	int test_idx = test_digit * shapesPerChar + test_sid;
	int mapMax = ppsMap - 1;
	int mapDen = pps > 1 ? pps - 1 : 1;
	tp.resize(pps*5);
	for (int j = 0; j < pps; j++) {
		int jm = j * mapMax / mapDen;
		for (int f = 0; f < 5; f++) tp[j*5+f] = pointsMap[test_idx][jm*5+f];
	}
}

emscripten::val getScoresBatchGlobalMT(int test_digit, int test_sid, int pointsPerShape, int outliersMul, emscripten::val slots, emscripten::val groups, double relax) {
	std::vector<int> slotList = emscripten::vecFromJSArray<int>(slots);
	std::vector<int> groupList = emscripten::vecFromJSArray<int>(groups);
	int outliers = outlierCount(pointsPerShape, outliersMul);
	int dim = pointsPerShape+outliers;
	std::vector<double> tp;
	mtSnapshotTest(tp, test_digit, test_sid, pointsPerShape);
	size_t n = slotList.size();
	std::vector<double> results(n, 0.0);
	std::vector<MTScratch> scr(g_nThreads + 1);
	for (auto &S : scr) S.ensure(dim, pointsPerShape);
	// probe: first slot of every group, exact, in parallel
	int maxGroup = 0;
	for (size_t s = 0; s < groupList.size(); s++) if (groupList[s] > maxGroup) maxGroup = groupList[s];
	std::vector<char> probed(maxGroup+1, 0), done(n, 0);
	std::vector<int> probeIdx;
	for (size_t s = 0; s < n; s++) {
		int grp = s < groupList.size() ? groupList[s] : 0;
		if (grp >= 0 && !probed[grp]) { probed[grp] = 1; probeIdx.push_back((int)s); done[s] = 1; }
	}
	runParallel((int)probeIdx.size(), [&](int i, int tid) {
		int s = probeIdx[i];
		mtFillBound(scr[tid], tp, slotList[s], pointsPerShape, outliers);
		results[s] = mtSolve(scr[tid], pointsPerShape, outliers);
	});
	double g1 = 1e30, g2 = 1e30;
	for (int s : probeIdx) { double c = results[s]; if (c < g1) { g2 = g1; g1 = c; } else if (c < g2) g2 = c; }
	double thresh = g2 * relax;
	// rest: fixed reference, parallel
	std::vector<int> restIdx;
	for (size_t s = 0; s < n; s++) if (!done[s]) restIdx.push_back((int)s);
	runParallel((int)restIdx.size(), [&](int i, int tid) {
		int s = restIdx[i];
		double bound = mtFillBound(scr[tid], tp, slotList[s], pointsPerShape, outliers);
		if (bound >= thresh) results[s] = -bound;
		else results[s] = mtSolve(scr[tid], pointsPerShape, outliers);
	});
	emscripten::val out = emscripten::val::array();
	for (size_t s = 0; s < n; s++) out.set(s, results[s]);
	return out;
}

emscripten::val getScoresBatchPrunedMT(int test_digit, int test_sid, int pointsPerShape, int outliersMul, emscripten::val slots, emscripten::val groups) {
	std::vector<int> slotList = emscripten::vecFromJSArray<int>(slots);
	std::vector<int> groupList = emscripten::vecFromJSArray<int>(groups);
	int outliers = outlierCount(pointsPerShape, outliersMul);
	int dim = pointsPerShape+outliers;
	std::vector<double> tp;
	mtSnapshotTest(tp, test_digit, test_sid, pointsPerShape);
	size_t n = slotList.size();
	std::vector<double> results(n, 0.0);
	std::vector<MTScratch> scr(g_nThreads + 1);
	for (auto &S : scr) S.ensure(dim, pointsPerShape);
	// exact phase: first TWO slots per group (classCombine needs best-2 exact)
	int maxGroup = 0;
	for (size_t s = 0; s < groupList.size(); s++) if (groupList[s] > maxGroup) maxGroup = groupList[s];
	std::vector<int> seen(maxGroup+1, 0);
	std::vector<char> done(n, 0);
	std::vector<int> exactIdx;
	for (size_t s = 0; s < n; s++) {
		int grp = s < groupList.size() ? groupList[s] : 0;
		if (grp >= 0 && seen[grp] < 2) { seen[grp]++; exactIdx.push_back((int)s); done[s] = 1; }
	}
	runParallel((int)exactIdx.size(), [&](int i, int tid) {
		int s = exactIdx[i];
		mtFillBound(scr[tid], tp, slotList[s], pointsPerShape, outliers);
		results[s] = mtSolve(scr[tid], pointsPerShape, outliers);
	});
	std::vector<double> gRef(maxGroup+1, 1e30); // per-group 2nd best (fixed)
	{
		std::vector<double> b1(maxGroup+1, 1e30), b2(maxGroup+1, 1e30);
		for (int s : exactIdx) {
			int grp = groupList[s];
			double c = results[s];
			if (c < b1[grp]) { b2[grp] = b1[grp]; b1[grp] = c; }
			else if (c < b2[grp]) b2[grp] = c;
		}
		for (int g = 0; g <= maxGroup; g++) gRef[g] = b2[g];
	}
	std::vector<int> restIdx;
	for (size_t s = 0; s < n; s++) if (!done[s]) restIdx.push_back((int)s);
	runParallel((int)restIdx.size(), [&](int i, int tid) {
		int s = restIdx[i];
		int grp = groupList[s];
		double bound = mtFillBound(scr[tid], tp, slotList[s], pointsPerShape, outliers);
		if (bound >= gRef[grp]) results[s] = -bound;
		else results[s] = mtSolve(scr[tid], pointsPerShape, outliers);
	});
	emscripten::val out = emscripten::val::array();
	for (size_t s = 0; s < n; s++) out.set(s, results[s]);
	return out;
}
#endif // __EMSCRIPTEN_PTHREADS__

/** Global-pruned batch scoring AND class combination, entirely in C++.
 *  Identical math to getScoresBatchGlobal + the caller's best^2*second, but
 *  nothing large crosses the JS boundary: no slots/groups arrays in, no
 *  per-template score array out. It walks spcMap directly and returns just the
 *  top-3 like identify(). At 6500 templates the old path marshalled 13,000
 *  values per character; this marshals 6.
 *  `nClassesToScore` bounds the class loop so a scratch class holding the test
 *  cloud is not scored against itself. */
ArrayInStruct identifyBatch(int test_digit, int test_sid, int pointsPerShape, int outliersMul, double relax, int nClassesToScore) {
	int i; int j;
	ArrayInStruct o;
	o.char1=0; o.char2=0; o.char3=0;
	o.sid1=-1; o.sid2=-1; o.sid3=-1;
	o.value1=1e30; o.value2=1e30; o.value3=1e30;
	int test_idx = test_digit * shapesPerChar + test_sid;
	if (pointsPerShape < 1 || ppsMap < 1 || !slotOK(test_idx)) return o;   // nothing to match

	int outliers = outlierCount(pointsPerShape, outliersMul);
	int dim = pointsPerShape+outliers;
	// Solver workspace, kept between calls: one contiguous dim x dim block.
	static std::vector<double> cmStore;
	static std::vector<double*> cmRows;
	static std::vector<int> rowsolV, colsolV;
	static std::vector<double> uV, vV, rowMinV;
	if ((int)cmRows.size() != dim) {
		cmStore.resize((size_t)dim*dim);
		cmRows.resize(dim);
		for (i=0;i<dim;i++) cmRows[i] = cmStore.data() + (size_t)i*dim;
		rowsolV.resize(dim); colsolV.resize(dim); uV.resize(dim); vV.resize(dim);
	}
	rowMinV.resize(pointsPerShape);
	double** costMatrix = cmRows.data();
	int *rowsol = rowsolV.data();
	int *colsol = colsolV.data();
	double *u = uV.data();
	double *v = vV.data();
	double *rowMin = rowMinV.data();
	for (i=pointsPerShape;i<dim;i++)
		for (j=0;j<dim;j++) costMatrix[i][j] = outlierCost;
	for (i=0;i<dim;i++)
		for (j=pointsPerShape;j<dim;j++) costMatrix[i][j] = outlierCost;

	int mapMax = ppsMap - 1;
	int mapDen = pointsPerShape > 1 ? pointsPerShape - 1 : 1;
	std::vector<double> tp(pointsPerShape*5);
	for (j=0; j<pointsPerShape; j++) {
		int jm = j*mapMax/mapDen;
		for (int f=0; f<5; f++) tp[j*5+f] = pointsMap[test_idx][jm*5+f];
	}

	double denomD = dim;
	double g1 = 1e30, g2 = 1e30;
	int nc = nClassesToScore < nchars ? nClassesToScore : nchars;
	if (nc < 0) nc = 0;
	std::vector<double> best(nc, 1e30), second(nc, 1e30);
	std::vector<int> bestSid(nc, -1);

	// Partial-bound early exit. After k rows, sum_k - outliers*maxCost is a
	// valid lower bound on the final bound: at most `outliers` rows are ever
	// dropped and each is worth at most maxCost. Monotone in k and needs only
	// a running sum, so a hopeless template can be abandoned mid-fill instead
	// of paying the full O(pps^2). identify() has a fixed-threshold form of
	// this (innerMax); this is the adaptive version, which fires far more
	// often because g2 is far tighter than maxCost*pps.
	//
	// The parameters are copied into locals so the pair loop keeps them in
	// registers (as globals they are reloaded after every matrix store), and
	// the per-axis gate test is skipped when it is disabled (gateAxisT at its
	// 1e300 "off" value: any pair it could catch has dist^2 = inf and is
	// caught by the radius test). Same operations in the same order as every
	// other fill in this file.
	const double kAlpha = alpha, kBeta = beta, kGamma = kappaGamma, kMax = maxCost;
	const double kRad = gateRadT, kAxis = gateAxisT;
	const bool kGate = gateOn != 0, kAxisOn = kGate && kAxis < 1e300;
	const double* tq = tp.data();
	double slackRaw = (double)outliers * maxCost;
	const double ABANDONED = 1e300;   // fillAndBound's "gave up mid-fill" result
	auto fillAndBound = [&](int temp_idx, double cutoffRaw) -> double {
		double running = 0;
		const double* tm = pointsMap[temp_idx].data();
		for(i=0; i<pointsPerShape; i++) {
			const double* t = tm + (i*mapMax/mapDen)*5;
			const double xx1 = t[0], yy1 = t[1], a1 = t[2], x1 = t[3], k1 = t[4];
			double* row = costMatrix[i];
			double rm = 1e30;
			for(j=0; j<pointsPerShape; j++) {
				const double* q = tq + j*5;
				double xx2 = q[0]-xx1;
				double yy2 = q[1]-yy1;
				if (kAxisOn && (xx2 > kAxis || xx2 < -kAxis ||
						yy2 > kAxis || yy2 < -kAxis)) {
					row[j] = kMax;
					if (kMax < rm) rm = kMax;
					continue;
				}
				double ddis = xx2*xx2+yy2*yy2;
				if (kGate && ddis >= kRad) {
					row[j] = kMax;
					if (kMax < rm) rm = kMax;
					continue;
				}
				double y2 = q[2]-a1;
				double x2 = q[3]-x1;
				double inside1 = y2*y2+x2*x2;
				if (inside1 > 2) inside1 = 4-inside1;
				double kdiff = q[4]-k1;
				if (kdiff < 0) kdiff = -kdiff;
				double inside2 = inside1 * kAlpha + ddis * kBeta + kdiff * kGamma;
				inside1 = inside2*inside2;
				double c = inside1 > kMax ? kMax : inside1;
				row[j] = c;
				if (c < rm) rm = c;
			}
			rowMin[i] = rm;
			running += rm;
			// The matrix is only partly filled from here on, so the caller must
			// not solve it: report a bound no reference can beat. (Returning
			// (running - slackRaw)/denomD left that to a second comparison,
			// which rounding could in principle answer the other way.)
			if (running - slackRaw >= cutoffRaw) return ABANDONED;
		}
		// bound = the smallest (pps - outliers) row minima, summed in ascending
		// order. Sorted in place by insertion: rowMin is rewritten by the next
		// fill, pps is small, and it keeps std::sort out of the lite build.
		for (i=1; i<pointsPerShape; i++) {
			double x = rowMin[i];
			for (j=i-1; j>=0 && rowMin[j] > x; j--) rowMin[j+1] = rowMin[j];
			rowMin[j+1] = x;
		}
		int payRows = pointsPerShape - outliers;
		if (payRows < 0) payRows = 0;
		double bound = 0;
		for (i=0; i<payRows; i++) bound += rowMin[i];
		bound += outlierCost * outliers;
		return bound / denomD;
	};
	// `cutoffRaw`: the total this template would have to come in under to matter.
	// The solver stops as soon as it can prove the optimum is not below it — the
	// same judgement the fill bound makes ("cannot beat g2*relax: leave it out"),
	// made with the solver's own, much tighter, lower bound — and a template
	// stopped this way is left out exactly as one the fill bound skipped is.
	//
	// MEASURED (Nov 2026, 3-fold on one writer's drill cells, 25 points, top-1):
	//                         solve all    leave out    keep the bound as its cost
	//   62 classes, all cells   771/830      771          769
	//   62 classes, 4 each      722/830      722          720
	//   lowercase, all cells    375/381      377          374
	//   lowercase, 4 each       354/381      356          353
	//   digits (both)           126, 119     same         same
	// and it is the fastest of the three (517 vs 609 us/query on lowercase; the
	// old solver took 709). On the 500 MNIST photo tests it reads 95.0% against
	// 95.4% — two tests. Define ASSIGN_EXACT_BATCH to solve everything.
	auto solveExact = [&](int ati, int sid, double cutoffRaw) {
#ifdef ASSIGN_EXACT_BATCH
		cutoffRaw = ASSIGN_INF;
#endif
		AssignResult ar = assignSolve(dim, costMatrix, rowsol, colsol, u, v, cutoffRaw, outliers, outlierCost);
		if (ar.rejected) return;
		double cost = ar.cost / denomD;
		if (cost < g1) { g2 = g1; g1 = cost; }
		else if (cost < g2) g2 = cost;
		if (cost < best[ati]) { second[ati] = best[ati]; best[ati] = cost; bestSid[ati] = sid; }
		else if (cost < second[ati]) second[ati] = cost;
	};

	// pass 1: one exact probe per class, for the tightest global reference
	for (int ati=0; ati<nc; ati++) {
		if (spcMap[ati] <= 0) continue;
		fillAndBound(ati*shapesPerChar, 1e300);   // no cutoff during probing
		solveExact(ati, 0, ASSIGN_INF);
	}
	// pass 2: bound everything else, solve only what could still place
	for (int ati=0; ati<nc; ati++) {
		for (int sid=1; sid<spcMap[ati]; sid++) {
			double b = fillAndBound(ati*shapesPerChar + sid, g2*relax*denomD);
			if (b >= g2*relax) continue;
			solveExact(ati, sid, g2*relax*denomD);
		}
	}

	double m1=1e30, m2=1e30, m3=1e30;
	int c1=0, c2=0, c3=0, s1=-1, s2=-1, s3=-1;
	for (int ati=0; ati<nc; ati++) {
		if (best[ati] >= 1e30) continue;
		double sc;
		if (second[ati] >= 1e30) sc = 0.9*best[ati]*best[ati]*best[ati];
		else sc = best[ati]*best[ati]*second[ati];
		if (sc < m1) { m3=m2; c3=c2; s3=s2; m2=m1; c2=c1; s2=s1; m1=sc; c1=ati; s1=bestSid[ati]; }
		else if (sc < m2) { m3=m2; c3=c2; s3=s2; m2=sc; c2=ati; s2=bestSid[ati]; }
		else if (sc < m3) { m3=sc; c3=ati; s3=bestSid[ati]; }
	}
	o.char1=c1; o.char2=c2; o.char3=c3;
	o.sid1=s1; o.sid2=s2; o.sid3=s3;
	o.value1=m1; o.value2=m2; o.value3=m3;
	return o;
}
/** Scratch buffer for externally-computed bounds (e.g. a WebGPU kernel).
 *  JS sizes it once, gets the pointer, and writes straight into the wasm heap
 *  via HEAPF32 — one typed-array copy instead of per-value marshalling. */
static std::vector<float> gBounds;
int boundsPtr(int n) {
	if ((int)gBounds.size() < n) gBounds.resize(n);
	return (int)(uintptr_t)gBounds.data();
}

/** External ORDERING key for classCostsCore's scan, indexed by slot exactly as
 *  gBounds is. Written by the caller (a $Q-style point-cloud pass ranks
 *  templates measurably better than their bounds do).
 *
 *  Order and CUT are separate jobs. The cut tests must stay on gBounds, which
 *  is admissible: a template it rules out provably cannot enter its class's
 *  best two. The ORDER is free to be anything — a better one simply reaches the
 *  ruling-out template sooner.
 *
 *  The kept set is NOT order-invariant, and it was wrong to assume so. Pass 1
 *  prunes against `topScores[K-1]`, which tightens as good classes are found,
 *  so a better order prunes MORE — every skip still bound-justified, but more
 *  classes end up on the optimistic lb^3 estimate instead of a solved score.
 *  Measured: word error identical, three characters different on two pages.
 *
 *  The one structural consequence: pass 1 and pass 2 currently `break` out of
 *  their loops, which is only valid because the arrays are bound-ascending. In
 *  key order they must `continue` instead, and the classes never visited are
 *  then identified from `kept` rather than from where the loop stopped. That
 *  rewrite is behaviour-preserving at gOrderMode 0 — verify-regression.mjs is
 *  the check. */
std::vector<float> gOrderKey;
static int gOrderMode = 0;   // 0 = order by gBounds (default), 1 = by gOrderKey
static int gOrderCap = 0;    // 0 = every class eligible; N = only the first N in key order

int orderKeyPtr(int n) {
	if ((int)gOrderKey.size() < n) gOrderKey.resize(n);
	return (int)(uintptr_t)gOrderKey.data();
}

/** cap > 0 makes the scan APPROXIMATE: classes past the cap in key order are
 *  never solved and keep their bound estimate, whatever the bound says. That is
 *  the aggression dial; cap 0 leaves the prune exact. */
void setOrderMode(int m, int cap) { gOrderMode = m; gOrderCap = cap; }

/** identifyBatch, but the LOWER BOUNDS ARE ALREADY KNOWN — supplied in
 *  gBounds indexed by slot (class*shapesPerChar + sid). Skips the O(pps^2)
 *  fill-and-bound over every template (the part a GPU can do ~12x faster) and
 *  only fills+solves the templates the bounds cannot rule out. Same prune rule
 *  and same best^2*second combination as identifyBatch, so results match. */
ArrayInStruct identifyFromBounds(int test_digit, int test_sid, int pointsPerShape, int outliersMul, double relax, int nClassesToScore, int solver) {
	int i; int j;
	int outliers = outlierCount(pointsPerShape, outliersMul);
	int dim = pointsPerShape+outliers;
	// Solver workspace reused across calls — the old code did `dim` heap
	// allocations plus frees on EVERY character.
	static std::vector<std::vector<double> > cmStore;
	static std::vector<double*> cmRows;
	static std::vector<int> rowsolV, colsolV;
	static std::vector<double> uV, vV;
	if ((int)cmStore.size() != dim || cmStore.empty() || (int)cmStore[0].size() != dim) {
		cmStore.assign(dim, std::vector<double>(dim, 0.0));
		cmRows.resize(dim);
		for (i=0;i<dim;i++) cmRows[i] = cmStore[i].data();
		rowsolV.resize(dim); colsolV.resize(dim); uV.resize(dim); vV.resize(dim);
	}
	double** costMatrix = cmRows.data();
	int *rowsol = rowsolV.data();
	int *colsol = colsolV.data();
	double *u = uV.data();
	double *v = vV.data();
	for (i=pointsPerShape;i<dim;i++)
		for (j=0;j<dim;j++) costMatrix[i][j] = outlierCost;
	for (i=0;i<dim;i++)
		for (j=pointsPerShape;j<dim;j++) costMatrix[i][j] = outlierCost;

	int test_idx = test_digit * shapesPerChar + test_sid;
	int mapMax = ppsMap - 1;
	int mapDen = pointsPerShape > 1 ? pointsPerShape - 1 : 1;
	std::vector<double> tp(pointsPerShape*5);
	for (j=0; j<pointsPerShape; j++) {
		int jm = j*mapMax/mapDen;
		for (int f=0; f<5; f++) tp[j*5+f] = pointsMap[test_idx][jm*5+f];
	}

	double denomD = dim;
	double g1 = 1e30, g2 = 1e30;
	int nc = nClassesToScore < nchars ? nClassesToScore : nchars;
	std::vector<double> best(nc, 1e30), second(nc, 1e30);
	std::vector<int> bestSid(nc, -1);

	// fill only — no row minima, no sort; the bound is already supplied
	auto fillOnly = [&](int temp_idx) {
		for(i=0; i<pointsPerShape; i++) {
			int im = i*mapMax/mapDen;
			double a1 = pointsMap[temp_idx][im*5+2];
			double xx1 = pointsMap[temp_idx][im*5+0];
			double yy1 = pointsMap[temp_idx][im*5+1];
			double x1 = pointsMap[temp_idx][im*5+3];
			double k1 = pointsMap[temp_idx][im*5+4];
			for(j=0; j<pointsPerShape; j++) {
				double xx2 = tp[j*5+0]-xx1;
				double yy2 = tp[j*5+1]-yy1;
				if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
						yy2 > gateAxisT || yy2 < -gateAxisT)) { costMatrix[i][j] = maxCost; continue; }
				double ddis = xx2*xx2+yy2*yy2;
				if (gateOn && ddis >= gateRadT) { costMatrix[i][j] = maxCost; continue; }
				double y2 = tp[j*5+2]-a1;
				double x2 = tp[j*5+3]-x1;
				double inside1 = y2*y2+x2*x2;
				if (inside1 > 2) inside1 = 4-inside1;
				double kdiff = tp[j*5+4]-k1;
				if (kdiff < 0) kdiff = -kdiff;
				double inside2 = inside1 * alpha + ddis * beta + kdiff * kappaGamma;
				inside1 = inside2*inside2;
				costMatrix[i][j] = inside1 > maxCost ? maxCost : inside1;
			}
		}
	};
	// solver 1: greedy matching — cheapest free pair repeatedly. 2.3x cheaper
	// per solve than the LAP but returns an UPPER bound, which inflates g2 and
	// therefore loosens the prune, costing more solves.
	std::vector<std::pair<double,int> > edges;
	edges.reserve((size_t)pointsPerShape*pointsPerShape);
	std::vector<unsigned char> usedR(pointsPerShape), usedC(pointsPerShape);
	int needM = pointsPerShape - outliers; if (needM < 0) needM = 0;
	auto solveExact = [&](int ati, int sid) {
		double cost;
		if (solver == 1) {
			edges.clear();
			for (int a=0;a<pointsPerShape;a++)
				for (int b=0;b<pointsPerShape;b++) {
					double c = costMatrix[a][b];
					if (c < maxCost) edges.push_back(std::make_pair(c, a*pointsPerShape + b));
				}
			std::sort(edges.begin(), edges.end());
			for (int a=0;a<pointsPerShape;a++){ usedR[a]=0; usedC[a]=0; }
			int made=0; double tot=0;
			for (size_t e=0; e<edges.size() && made<needM; e++) {
				int r = edges[e].second / pointsPerShape;
				int cc = edges[e].second % pointsPerShape;
				if (usedR[r] || usedC[cc]) continue;
				usedR[r]=1; usedC[cc]=1; tot += edges[e].first; made++;
			}
			while (made < needM) { tot += maxCost; made++; }
			tot += outlierCost * outliers;
			cost = tot / denomD;
		} else {
			for (i=0;i<dim;i++){ rowsol[i]=i; colsol[i]=i; u[i]=0; v[i]=0; }
			cost = lapOutliers(dim, costMatrix, rowsol, colsol, u, v, outliers, outlierCost) / denomD;
		}
		if (cost < g1) { g2 = g1; g1 = cost; }
		else if (cost < g2) g2 = cost;
		if (cost < best[ati]) { second[ati] = best[ati]; best[ati] = cost; bestSid[ati] = sid; }
		else if (cost < second[ati]) second[ati] = cost;
	};

	// pass 1: probe each class's best-bound template — but skip classes the
	// bounds already rule out. score_c = best^2*second >= B_c^3 (second >= best
	// >= B_c), so a class whose bound cubed exceeds the 3rd-best score so far
	// cannot reach the top 3 and its probe is pure waste. Visiting classes in
	// ASCENDING bound order finds the leader immediately, so the test starts
	// biting after a handful of classes, and the loop can break outright.
	// Top-3 and their values stay EXACT — confidence reads value1/value2.
	std::vector<int> probedSid(nc, -1);
	std::vector<float> classBound(nc, 1e30f);
	std::vector<int> classBest(nc, -1);
	int nSolved = 0;
	for (int ati=0; ati<nc; ati++) {
		int n = spcMap[ati];
		if (n <= 0) continue;
		int bi = -1; float bv = 1e30f;
		for (int sid=0; sid<n; sid++) {
			float b = gBounds[(size_t)ati*shapesPerChar + sid];
			if (b < bv) { bv = b; bi = sid; }
		}
		classBound[ati] = bv; classBest[ati] = bi;
	}
	std::vector<int> order;
	for (int ati=0; ati<nc; ati++) if (classBest[ati] >= 0) order.push_back(ati);
	std::sort(order.begin(), order.end(),
		[&](int a, int b){ return classBound[a] < classBound[b]; });
	double s1v=1e30, s2v=1e30, s3v=1e30;
	for (size_t oi=0; oi<order.size(); oi++) {
		int ati = order[oi];
		double lb = (double)classBound[ati];
		if (lb*lb*lb >= s3v) break;
		probedSid[ati] = classBest[ati];
		fillOnly(ati*shapesPerChar + classBest[ati]);
		solveExact(ati, classBest[ati]); nSolved++;
		double sc = (second[ati] >= 1e30) ? 0.9*best[ati]*best[ati]*best[ati]
		                                  : best[ati]*best[ati]*second[ati];
		if (sc < s1v) { s3v=s2v; s2v=s1v; s1v=sc; }
		else if (sc < s2v) { s3v=s2v; s2v=sc; }
		else if (sc < s3v) { s3v=sc; }
	}
	// pass 2: only what the bounds cannot rule out
	for (int ati=0; ati<nc; ati++) {
		if (probedSid[ati] < 0) continue;   // class ruled out by its bound
		int n = spcMap[ati];
		for (int sid=0; sid<n; sid++) {
			if (sid == probedSid[ati]) continue;
			if (gBounds[(size_t)ati*shapesPerChar + sid] >= g2*relax) continue;
			fillOnly(ati*shapesPerChar + sid);
			solveExact(ati, sid); nSolved++;
		}
	}

	double m1=1e30, m2=1e30, m3=1e30;
	int c1=0, c2=0, c3=0, s1=-1, s2=-1, s3=-1;
	for (int ati=0; ati<nc; ati++) {
		if (best[ati] >= 1e30) continue;
		double sc = (second[ati] >= 1e30) ? 0.9*best[ati]*best[ati]*best[ati]
		                                  : best[ati]*best[ati]*second[ati];
		if (sc < m1) { m3=m2;c3=c2;s3=s2; m2=m1;c2=c1;s2=s1; m1=sc;c1=ati;s1=bestSid[ati]; }
		else if (sc < m2) { m3=m2;c3=c2;s3=s2; m2=sc;c2=ati;s2=bestSid[ati]; }
		else if (sc < m3) { m3=sc;c3=ati;s3=bestSid[ati]; }
	}
	ArrayInStruct o;
	o.char1=c1;o.char2=c2;o.char3=c3; o.sid1=s1;o.sid2=nSolved;o.sid3=s3;
	o.value1=m1;o.value2=m2;o.value3=m3;
	return o;
}

/** Fill gBounds[slot] for EVERY template with the row-minimum lower bound —
 *  the same quantity a WebGPU kernel produces, computed on the CPU. Splitting
 *  the bound pass out like this means the CPU and GPU paths differ only in WHO
 *  produced the bounds: both then run classCostsFromBounds, so an A/B is exact
 *  rather than approximate. O(pps^2) per template, no assignment solved. */
void computeBounds(int test_digit, int test_sid, int pointsPerShape, int outliersMul, int nClassesToScore) {
	int i, j;
	int outliers = outlierCount(pointsPerShape, outliersMul);
	int dim = pointsPerShape+outliers;
	int nc = nClassesToScore < nchars ? nClassesToScore : nchars;
	// Callers hold a raw pointer from boundsPtr(), which a resize would
	// invalidate. Both callers size the buffer through boundsPtr(nClasses *
	// shapesPerChar) first, so this is a no-op guard, not a growth path.
	if ((int)gBounds.size() < nc*shapesPerChar) gBounds.resize(nc*shapesPerChar, 1e30f);

	int test_idx = test_digit * shapesPerChar + test_sid;
	int mapMax = ppsMap - 1;
	int mapDen = pointsPerShape > 1 ? pointsPerShape - 1 : 1;
	std::vector<double> tp(pointsPerShape*5);
	for (j=0; j<pointsPerShape; j++) {
		int jm = j*mapMax/mapDen;
		for (int f=0; f<5; f++) tp[j*5+f] = pointsMap[test_idx][jm*5+f];
	}
	int payRows = pointsPerShape - outliers;
	if (payRows < 0) payRows = 0;
	std::vector<double> rms(pointsPerShape);

	for (int ati=0; ati<nc; ati++) {
		int n = spcMap[ati];
		for (int sid=0; sid<n; sid++) {
			int temp_idx = ati*shapesPerChar + sid;
			for(i=0; i<pointsPerShape; i++) {
				int im = i*mapMax/mapDen;
				double xx1 = pointsMap[temp_idx][im*5+0];
				double yy1 = pointsMap[temp_idx][im*5+1];
				double a1  = pointsMap[temp_idx][im*5+2];
				double x1  = pointsMap[temp_idx][im*5+3];
				double k1  = pointsMap[temp_idx][im*5+4];
				double rm = 1e30;
				for(j=0; j<pointsPerShape; j++) {
					double xx2 = tp[j*5+0]-xx1;
					double yy2 = tp[j*5+1]-yy1;
					if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
							yy2 > gateAxisT || yy2 < -gateAxisT)) {
						if (maxCost < rm) rm = maxCost;
						continue;
					}
					double ddis = xx2*xx2+yy2*yy2;
					if (gateOn && ddis >= gateRadT) {
						if (maxCost < rm) rm = maxCost;
						continue;
					}
					double y2 = tp[j*5+2]-a1;
					double x2 = tp[j*5+3]-x1;
					double inside1 = y2*y2+x2*x2;
					if (inside1 > 2) inside1 = 4-inside1;
					double kdiff = tp[j*5+4]-k1;
					if (kdiff < 0) kdiff = -kdiff;
					double inside2 = inside1 * alpha + ddis * beta + kdiff * kappaGamma;
					inside1 = inside2*inside2;
					double c = inside1 > maxCost ? maxCost : inside1;
					if (c < rm) rm = c;
				}
				rms[i] = rm;
			}
			std::sort(rms.begin(), rms.end());
			double bound = 0;
			for (i=0; i<payRows; i++) bound += rms[i];
			bound += outlierCost * outliers;
			gBounds[(size_t)temp_idx] = (float)(bound / (double)dim);
		}
	}
}

/** Per-class combined costs out (the word decoder's surface). */
/**
 * MAX-REGRET MATCHING — an alternative to the LAP (Vogel's approximation
 * method, applied to the assignment problem).
 *
 * Cheapest-edge-first greedy commits to whatever pair happens to be globally
 * cheapest, which is often a pair that had a perfectly good second choice. This
 * instead asks, for every row and every column, "how much worse off am I if I
 * do NOT get my first choice" — the gap between its best and second-best
 * available partner — and commits the row or column with the most to lose.
 * Rows and columns compete on the same scale, so the scarcest commitment
 * always goes first.
 *
 *   O(n^2) to seed, then each of the n rounds costs an O(n) scan for the
 *   largest regret plus a repair of only those rows/columns whose top-two
 *   referenced the pair just removed. The LAP is O(n^3) with a much larger
 *   constant (augmenting-path search).
 *
 * It runs on the REAL pointsPerShape x pointsPerShape block only. The outlier
 * rows/columns are all-outlierCost, so every real row could reach cost 0 there
 * and every regret would be zero — the heuristic would degenerate. Instead it
 * matches exactly `needM = pps - outliers` pairs, which is precisely the
 * cardinality the LAP's free dummy rows and columns produce.
 *
 * Returns the summed cost of the matched pairs (the caller adds the outlier
 * term and divides). It is an UPPER bound on the LAP optimum, not a lower one —
 * which matters for pruning: see the note at the call site.
 */
static std::vector<double> rmB1, rmB2, cmB1, cmB2;
static std::vector<int> rmA1, rmA2, cmA1, cmA2;
static std::vector<unsigned char> rmDead, cmDead;

static std::vector<double> rmPicked;

/** `keepM < n` selects the DROP-THE-WORST variant: run all n rounds, then keep
 *  only the cheapest keepM pairs. This matters because the outlier columns make
 *  dropping FREE, and plain max-regret is the wrong rule for a problem with
 *  free drops — a row whose best is 80 and second-best 90 has a big regret and
 *  gets committed early, when the right move is to drop it. Ordering by regret
 *  still decides WHO pairs with whom; the drop decides who pays. */
static double regretMatch(double** cm, int n, int needM, bool dropWorst) {
	rmB1.assign(n, 1e30); rmB2.assign(n, 1e30); rmA1.assign(n, -1); rmA2.assign(n, -1);
	cmB1.assign(n, 1e30); cmB2.assign(n, 1e30); cmA1.assign(n, -1); cmA2.assign(n, -1);
	rmDead.assign(n, 0); cmDead.assign(n, 0);
	for (int i = 0; i < n; i++) {
		const double* row = cm[i];
		for (int j = 0; j < n; j++) {
			double v = row[j];
			if (v < rmB1[i]) { rmB2[i]=rmB1[i]; rmA2[i]=rmA1[i]; rmB1[i]=v; rmA1[i]=j; }
			else if (v < rmB2[i]) { rmB2[i]=v; rmA2[i]=j; }
			if (v < cmB1[j]) { cmB2[j]=cmB1[j]; cmA2[j]=cmA1[j]; cmB1[j]=v; cmA1[j]=i; }
			else if (v < cmB2[j]) { cmB2[j]=v; cmA2[j]=i; }
		}
	}
	double total = 0;
	int rounds = dropWorst ? n : needM;
	if (dropWorst) rmPicked.clear();
	for (int step = 0; step < rounds; step++) {
		double best = -1.0; int bi = -1; bool isRow = true;
		for (int i = 0; i < n; i++) if (!rmDead[i]) {
			double g = (rmB2[i] >= 1e30) ? 1e29 : rmB2[i] - rmB1[i];
			if (g > best) { best = g; bi = i; isRow = true; }
		}
		for (int j = 0; j < n; j++) if (!cmDead[j]) {
			double g = (cmB2[j] >= 1e30) ? 1e29 : cmB2[j] - cmB1[j];
			if (g > best) { best = g; bi = j; isRow = false; }
		}
		if (bi < 0) break;
		int pi, pj;
		if (isRow) { pi = bi; pj = rmA1[bi]; } else { pj = bi; pi = cmA1[bi]; }
		if (pi < 0 || pj < 0) break;
		if (dropWorst) rmPicked.push_back(cm[pi][pj]);
		else total += cm[pi][pj];
		rmDead[pi] = 1; cmDead[pj] = 1;
		// repair only what the removal invalidated: a row/column whose top-two
		// pointed at the pair just taken. Anything pointing at an EARLIER
		// removal was repaired when that removal happened.
		for (int i = 0; i < n; i++) {
			if (rmDead[i] || (rmA1[i] != pj && rmA2[i] != pj)) continue;
			double b1 = 1e30, b2 = 1e30; int a1 = -1, a2 = -1;
			const double* row = cm[i];
			for (int j = 0; j < n; j++) {
				if (cmDead[j]) continue;
				double v = row[j];
				if (v < b1) { b2=b1; a2=a1; b1=v; a1=j; }
				else if (v < b2) { b2=v; a2=j; }
			}
			rmB1[i]=b1; rmB2[i]=b2; rmA1[i]=a1; rmA2[i]=a2;
		}
		for (int j = 0; j < n; j++) {
			if (cmDead[j] || (cmA1[j] != pi && cmA2[j] != pi)) continue;
			double b1 = 1e30, b2 = 1e30; int a1 = -1, a2 = -1;
			for (int i = 0; i < n; i++) {
				if (rmDead[i]) continue;
				double v = cm[i][j];
				if (v < b1) { b2=b1; a2=a1; b1=v; a1=i; }
				else if (v < b2) { b2=v; a2=i; }
			}
			cmB1[j]=b1; cmB2[j]=b2; cmA1[j]=a1; cmA2[j]=a2;
		}
	}
	if (dropWorst) {
		std::sort(rmPicked.begin(), rmPicked.end());
		int keep = needM < (int)rmPicked.size() ? needM : (int)rmPicked.size();
		for (int i = 0; i < keep; i++) total += rmPicked[i];
	}
	return total;
}

/** Warm-started escalation: reuse the cheap stage's assignment wholesale and
 *  solve only the points the cheap stage never saw. See stage B below. */
static int gWarm = 0;
void setWarmStart(int w) { gWarm = w; }

/** 0 = exact LAP (default), 2 = max-regret matching, 3 = max-regret with the
 *  worst pairs dropped. Global rather than a parameter so the word decoder can
 *  switch solvers without every entry point growing an argument. */
void setSolver(int s) { gSolver = s; }

static std::vector<float> gClassCost;
int classCostsPtr(int n) {
	if ((int)gClassCost.size() < n) gClassCost.resize(n);
	return (int)(uintptr_t)gClassCost.data();
}

/**
 * ALL-CLASS scoring from precomputed bounds — identifyFromBounds' machinery,
 * but the output is one combined cost per class instead of the top 3.
 *
 * A word decoder needs a cost for every class (the lexicon DP may ask for any
 * character), which is why identifyBatch/identifyFromBounds could not be used
 * as-is. The prune generalises from "cannot reach the top 3" to "cannot reach
 * the top `keepClasses`": score_c = best^2*second >= B_c^3, so once the K-th
 * best score so far is below B_c^3 the class is settled and B_c^3 is a valid
 * (and correctly-ordered) stand-in for it.
 *
 * Classes beyond K therefore receive their bound cubed, which is guaranteed
 * >= every kept class's score — a pruned class can never outrank a kept one,
 * so the DP sees a monotone surface rather than a floor that ties them all.
 *
 * `minPerClass` (>=2 recommended) forces each surviving class to solve that
 * many of its own templates in ascending-bound order, so its combined cost is
 * a genuine best^2*second rather than the 0.9*best^3 single-template fallback.
 * Mixing the two formulas across classes within one segment is a scale error
 * the word DP is directly sensitive to.
 *
 * Writes nClassesToScore floats to gClassCost; returns the number of LAPs
 * solved (for profiling).
 */
int classCostsCore(int test_digit, int test_sid, int pointsPerShape, int outliersMul,
                   double relax, int nClassesToScore, int keepClasses, int minPerClass,
                   int topK, int keepB, int escPps, int maxSolve) {
	int i, j;
	int outliers = outlierCount(pointsPerShape, outliersMul);
	int dim = pointsPerShape+outliers;
	static std::vector<std::vector<double> > cmStore;
	static std::vector<double*> cmRows;
	static std::vector<int> rowsolV, colsolV;
	static std::vector<double> uV, vV;
	if ((int)cmStore.size() != dim || cmStore.empty() || (int)cmStore[0].size() != dim) {
		cmStore.assign(dim, std::vector<double>(dim, 0.0));
		cmRows.resize(dim);
		for (i=0;i<dim;i++) cmRows[i] = cmStore[i].data();
		rowsolV.resize(dim); colsolV.resize(dim); uV.resize(dim); vV.resize(dim);
	}
	double** costMatrix = cmRows.data();
	int *rowsol = rowsolV.data();
	int *colsol = colsolV.data();
	double *u = uV.data();
	double *v = vV.data();
	for (i=pointsPerShape;i<dim;i++)
		for (j=0;j<dim;j++) costMatrix[i][j] = outlierCost;
	for (i=0;i<dim;i++)
		for (j=pointsPerShape;j<dim;j++) costMatrix[i][j] = outlierCost;

	int test_idx = test_digit * shapesPerChar + test_sid;
	int mapMax = ppsMap - 1;
	int mapDen = pointsPerShape > 1 ? pointsPerShape - 1 : 1;
	std::vector<double> tp(pointsPerShape*5);
	for (j=0; j<pointsPerShape; j++) {
		int jm = j*mapMax/mapDen;
		for (int f=0; f<5; f++) tp[j*5+f] = pointsMap[test_idx][jm*5+f];
	}

	double denomD = dim;
	double g1 = 1e30, g2 = 1e30;
	int nc = nClassesToScore < nchars ? nClassesToScore : nchars;
	if ((int)gClassCost.size() < nc) gClassCost.resize(nc);
	std::vector<double> best(nc, 1e30), second(nc, 1e30);

	auto fillOnly = [&](int temp_idx) {
		for(i=0; i<pointsPerShape; i++) {
			int im = i*mapMax/mapDen;
			double xx1 = pointsMap[temp_idx][im*5+0];
			double yy1 = pointsMap[temp_idx][im*5+1];
			double a1  = pointsMap[temp_idx][im*5+2];
			double x1  = pointsMap[temp_idx][im*5+3];
			double k1  = pointsMap[temp_idx][im*5+4];
			for(j=0; j<pointsPerShape; j++) {
				double xx2 = tp[j*5+0]-xx1;
				double yy2 = tp[j*5+1]-yy1;
				if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
						yy2 > gateAxisT || yy2 < -gateAxisT)) { costMatrix[i][j] = maxCost; continue; }
				double ddis = xx2*xx2+yy2*yy2;
				if (gateOn && ddis >= gateRadT) { costMatrix[i][j] = maxCost; continue; }
				double y2 = tp[j*5+2]-a1;
				double x2 = tp[j*5+3]-x1;
				double inside1 = y2*y2+x2*x2;
				if (inside1 > 2) inside1 = 4-inside1;
				double kdiff = tp[j*5+4]-k1;
				if (kdiff < 0) kdiff = -kdiff;
				double inside2 = inside1 * alpha + ddis * beta + kdiff * kappaGamma;
				inside1 = inside2*inside2;
				costMatrix[i][j] = inside1 > maxCost ? maxCost : inside1;
			}
		}
	};
	int nSolved = 0;
	int needM = pointsPerShape - outliers; if (needM < 0) needM = 0;
	// Cheap-stage totals, kept UNNORMALIZED and indexed by template, so stage B
	// can reuse them (see the warm-start note there). Only `warmHas` needs
	// clearing per query.
	static std::vector<double> warmTot;
	static std::vector<unsigned char> warmHas;
	if ((int)warmTot.size() < nc*shapesPerChar) { warmTot.resize(nc*shapesPerChar); warmHas.resize(nc*shapesPerChar); }
	if (gWarm) std::fill(warmHas.begin(), warmHas.begin() + nc*shapesPerChar, 0);
	auto solveExact = [&](int ati, int temp_idx) {
		double cost;
		if (gSolver >= 2) {
			cost = (regretMatch(costMatrix, pointsPerShape, needM, gSolver == 3)
			        + outlierCost * (dim - needM)) / denomD;
		} else {
			for (i=0;i<dim;i++){ rowsol[i]=i; colsol[i]=i; u[i]=0; v[i]=0; }
			cost = lapOutliers(dim, costMatrix, rowsol, colsol, u, v, outliers, outlierCost) / denomD;
		}
		nSolved++;
		if (gWarm && temp_idx >= 0) { warmTot[temp_idx] = cost * denomD; warmHas[temp_idx] = 1; }
		if (cost < g1) { g2 = g1; g1 = cost; }
		else if (cost < g2) g2 = cost;
		if (cost < best[ati]) { second[ati] = best[ati]; best[ati] = cost; }
		else if (cost < second[ati]) second[ati] = cost;
	};
	auto combine = [&](int ati) -> double {
		if (best[ati] >= 1e30) return 1e30;
		if (second[ati] >= 1e30) return 0.9*best[ati]*best[ati]*best[ati];
		return best[ati]*best[ati]*second[ati];
	};

	// The scan is ordered by `okey` and CUT by gBounds. They are the same array
	// unless setOrderMode(1) supplied an external ranking — see orderKeyPtr.
	const std::vector<float> &okey = (gOrderMode && (int)gOrderKey.size() >= nc*shapesPerChar)
		? gOrderKey : gBounds;
	const bool keyed = (&okey != &gBounds);

	// class bound = its best template bound; ascending order makes the top-K
	// test bite after a handful of classes
	std::vector<float> classBound(nc, 1e30f);
	std::vector<float> classKey(nc, 1e30f);
	std::vector<int> order;
	order.reserve(nc);
	for (int ati=0; ati<nc; ati++) {
		int n = spcMap[ati];
		if (n <= 0) continue;
		float bv = 1e30f, kv = 1e30f;
		for (int sid=0; sid<n; sid++) {
			float b = gBounds[(size_t)ati*shapesPerChar + sid];
			if (b < bv) bv = b;
			float k = okey[(size_t)ati*shapesPerChar + sid];
			if (k < kv) kv = k;
		}
		classBound[ati] = bv;
		classKey[ati] = kv;
		order.push_back(ati);
	}
	std::sort(order.begin(), order.end(),
		[&](int a, int b){ return classKey[a] < classKey[b]; });

	// pass 1: walk classes best-bound-first, solving `minPerClass` templates
	// each, until the K-th best score rules out the rest.
	int K = keepClasses > 0 ? keepClasses : nc;
	if (minPerClass < 1) minPerClass = 1;
	std::vector<double> topScores;     // K best class scores so far, ascending
	std::vector<char> kept(nc, 0);
	std::vector<std::pair<float,int> > tmpl;   // (bound, sid) for one class
	for (size_t oi = 0; oi < order.size(); oi++) {
		int ati = order[oi];
		double lb = (double)classBound[ati];
		// The prune is on the BOUND in both modes. In bound order a failure
		// means every later class fails too, so the scan can stop; in key order
		// it means only that THIS class is ruled out.
		if ((int)topScores.size() >= K && lb*lb*lb >= topScores[K-1]) {
			if (!keyed) break;
			continue;
		}
		// the aggression dial: past the cap, the class keeps its bound estimate
		if (keyed && gOrderCap > 0 && (int)oi >= gOrderCap) continue;
		int n = spcMap[ati];
		tmpl.clear();
		for (int sid=0; sid<n; sid++)
			tmpl.push_back(std::make_pair(okey[(size_t)ati*shapesPerChar + sid], sid));
		std::sort(tmpl.begin(), tmpl.end());
		int take = minPerClass < n ? minPerClass : n;
		for (int q=0; q<take; q++) {
			fillOnly(ati*shapesPerChar + tmpl[q].second);
			solveExact(ati, ati*shapesPerChar + tmpl[q].second);
		}
		kept[ati] = 1;
		double sc = combine(ati);
		// insert into the running top-K
		std::vector<double>::iterator it = std::lower_bound(topScores.begin(), topScores.end(), sc);
		topScores.insert(it, sc);
		if ((int)topScores.size() > K) topScores.resize(K);
	}
	// classes never visited: their bound cubed. Provably >= every kept score
	// when the prune did the ruling out, so ordering against the kept set holds.
	// Identified from `kept` rather than from where the loop stopped, because in
	// key order it does not stop — same set either way.
	for (int ati=0; ati<nc; ati++) {
		if (kept[ati]) continue;
		if (spcMap[ati] <= 0) { gClassCost[ati] = 1e30f; continue; }
		double lb = (double)classBound[ati];
		gClassCost[ati] = (float)(lb*lb*lb);
	}

	// pass 2: solve the remaining templates the global runner-up cannot rule
	// out — this is what makes best/second exact for the classes actually in
	// contention. Ordered by bound ACROSS ALL CLASSES rather than class by
	// class: g2 is what the prune tests against, so reaching the strongest
	// remaining template first tightens it as early as possible, and every
	// later template is then measured against a better reference. Class-major
	// order can grind through a mediocre class's whole pool before ever seeing
	// the template that would have ruled it out.
	std::vector<std::pair<float,int> > pass2;
	for (int ati=0; ati<nc; ati++) {
		if (!kept[ati]) continue;
		int n = spcMap[ati];
		tmpl.clear();
		for (int sid=0; sid<n; sid++)
			tmpl.push_back(std::make_pair(okey[(size_t)ati*shapesPerChar + sid], sid));
		std::sort(tmpl.begin(), tmpl.end());
		int take = minPerClass < n ? minPerClass : n;
		for (int q=take; q<n; q++)
			pass2.push_back(std::make_pair(tmpl[q].first, ati*shapesPerChar + tmpl[q].second));
	}
	std::sort(pass2.begin(), pass2.end());
	// maxSolve caps pass 2 outright. The relax test alone is exact but weak —
	// it leaves ~245 solves per query on a 1245-template bank — and the
	// templates it admits last are, by construction, the ones with the loosest
	// bounds. 0 = uncapped (the exact behaviour).
	int budget = maxSolve > 0 ? maxSolve : (int)pass2.size();
	for (size_t q = 0; q < pass2.size() && budget > 0; q++) {
		int ti = pass2[q].second;
		// Again: prune on the BOUND, order by the key. Bound-ascending lets the
		// loop stop; key-ascending only lets it skip.
		if ((double)gBounds[ti] >= g2*relax) { if (!keyed) break; else continue; }
		fillOnly(ti);
		solveExact(ti / shapesPerChar, ti);
		budget--;
	}
	for (int ati=0; ati<nc; ati++)
		if (kept[ati]) gClassCost[ati] = (float)combine(ati);
	if (topK <= 0 || escPps <= pointsPerShape) return nSolved;

	// ---- stage B: escalate the leaders to the higher resolution -------------
	// Same shape as the 25->100 cascade, with the class count opened up from 2
	// because a lexicon DP wants more than a winner. Templates are taken in
	// ascending CHEAP-bound order, which is the cheap stage's own ranking of
	// which templates are worth a full-resolution look.
	std::vector<int> lead;
	for (int ati=0; ati<nc; ati++) if (kept[ati] && gClassCost[ati] < 1e29f) lead.push_back(ati);
	std::sort(lead.begin(), lead.end(),
		[&](int a, int b){ return gClassCost[a] < gClassCost[b]; });
	if ((int)lead.size() > topK) lead.resize(topK);
	if (lead.empty()) return nSolved;

	int eOut = outlierCount(escPps, outliersMul);
	int eDim = escPps + eOut;
	static std::vector<std::vector<double> > ecm;
	static std::vector<double*> ecmRows;
	static std::vector<int> ersol, ecsol;
	static std::vector<double> euV, evV;
	if ((int)ecm.size() != eDim || ecm.empty() || (int)ecm[0].size() != eDim) {
		ecm.assign(eDim, std::vector<double>(eDim, 0.0));
		ecmRows.resize(eDim);
		for (i=0;i<eDim;i++) ecmRows[i] = ecm[i].data();
		ersol.resize(eDim); ecsol.resize(eDim); euV.resize(eDim); evV.resize(eDim);
	}
	double** ecost = ecmRows.data();
	for (i=escPps;i<eDim;i++) for (j=0;j<eDim;j++) ecost[i][j] = outlierCost;
	for (i=0;i<eDim;i++) for (j=escPps;j<eDim;j++) ecost[i][j] = outlierCost;
	int eMapDen = escPps > 1 ? escPps - 1 : 1;
	std::vector<double> etp(escPps*5);
	for (j=0; j<escPps; j++) {
		int jm = j*mapMax/eMapDen;
		for (int f=0; f<5; f++) etp[j*5+f] = pointsMap[test_idx][jm*5+f];
	}
	std::vector<double> eBest(nc, 1e30), eSecond(nc, 1e30);

	// ---- warm start ---------------------------------------------------------
	// The cheap stage matched a SUBSET of the stored points: at 30 of 50 it uses
	// stored indices i*49/29, which is a strict subset of 0..49. So the full
	// assignment can be built by keeping the cheap stage's answer for the points
	// it saw and matching only the ~20 it never did.
	//
	// Two facts make this almost free. First, a pair's cost does not depend on
	// pointsPerShape — only WHICH points participate and the /dim divisor do —
	// so the frozen part is exactly the cheap stage's own unnormalized total, no
	// re-fill needed. Second, the free rows and columns are the same fixed
	// complement for EVERY template (they come from the subsampling, not from
	// which pairs were chosen), so nothing per-template needs storing.
	//
	// The outlier accounting composes exactly: the cheap total already carries
	// its 12 dummy assignments and the reduced problem carries 8, which is the
	// 20 the full 50-point problem wants.
	//
	// It returns an UPPER bound on the true escalated cost, which is safe HERE
	// and would not have been in the cheap stage: stage B runs after every
	// prune, so nothing downstream tests a bound against these numbers.
	std::vector<int> freeIdx;
	bool warmOK = (gWarm != 0) && escPps == ppsMap;
	if (warmOK) {
		std::vector<unsigned char> seen(ppsMap, 0);
		for (i=0; i<pointsPerShape; i++) seen[i*mapMax/mapDen] = 1;
		for (i=0; i<ppsMap; i++) if (!seen[i]) freeIdx.push_back(i);
	}
	int nFree = (int)freeIdx.size();
	int needMore = (escPps - eOut) - (pointsPerShape - outliers);
	int rDrop = nFree - needMore;
	int rDim = nFree + rDrop;
	if (nFree <= 0 || needMore < 0 || rDrop < 0) warmOK = false;
	static std::vector<std::vector<double> > rcm;
	static std::vector<double*> rcmRows;
	static std::vector<int> rrsol, rcsol;
	static std::vector<double> ruV, rvV;
	if (warmOK) {
		if ((int)rcm.size() != rDim || rcm.empty() || (int)rcm[0].size() != rDim) {
			rcm.assign(rDim, std::vector<double>(rDim, 0.0));
			rcmRows.resize(rDim);
			for (i=0;i<rDim;i++) rcmRows[i] = rcm[i].data();
			rrsol.resize(rDim); rcsol.resize(rDim); ruV.resize(rDim); rvV.resize(rDim);
		}
		for (i=nFree;i<rDim;i++) for (j=0;j<rDim;j++) rcmRows[i][j] = outlierCost;
		for (i=0;i<rDim;i++) for (j=nFree;j<rDim;j++) rcmRows[i][j] = outlierCost;
	}

	for (size_t li=0; li<lead.size(); li++) {
		int ati = lead[li];
		int n = spcMap[ati];
		tmpl.clear();
		for (int sid=0; sid<n; sid++)
			tmpl.push_back(std::make_pair(okey[(size_t)ati*shapesPerChar + sid], sid));
		std::sort(tmpl.begin(), tmpl.end());
		int take = keepB < n ? keepB : n;
		for (int q=0; q<take; q++) {
			int temp_idx = ati*shapesPerChar + tmpl[q].second;
			if (warmOK && warmHas[temp_idx]) {
				double** rc = rcmRows.data();
				for (int a=0; a<nFree; a++) {
					int im = freeIdx[a];
					double xx1 = pointsMap[temp_idx][im*5+0];
					double yy1 = pointsMap[temp_idx][im*5+1];
					double a1  = pointsMap[temp_idx][im*5+2];
					double x1  = pointsMap[temp_idx][im*5+3];
					double k1  = pointsMap[temp_idx][im*5+4];
					for (int b=0; b<nFree; b++) {
						int jm = freeIdx[b];
						double xx2 = etp[jm*5+0]-xx1;
						double yy2 = etp[jm*5+1]-yy1;
						if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
								yy2 > gateAxisT || yy2 < -gateAxisT)) { rc[a][b] = maxCost; continue; }
						double ddis = xx2*xx2+yy2*yy2;
						if (gateOn && ddis >= gateRadT) { rc[a][b] = maxCost; continue; }
						double y2 = etp[jm*5+2]-a1;
						double x2 = etp[jm*5+3]-x1;
						double in1 = y2*y2+x2*x2;
						if (in1 > 2) in1 = 4-in1;
						double kd = etp[jm*5+4]-k1;
						if (kd < 0) kd = -kd;
						double in2 = in1 * alpha + ddis * beta + kd * kappaGamma;
						in1 = in2*in2;
						rc[a][b] = in1 > maxCost ? maxCost : in1;
					}
				}
				for (i=0;i<rDim;i++){ rrsol[i]=i; rcsol[i]=i; ruV[i]=0; rvV[i]=0; }
				double rTot = lap(rDim, rc, rrsol.data(), rcsol.data(), ruV.data(), rvV.data());
				double c = (warmTot[temp_idx] + rTot) / (double)eDim;
				nSolved++;
				if (c < eBest[ati]) { eSecond[ati] = eBest[ati]; eBest[ati] = c; }
				else if (c < eSecond[ati]) eSecond[ati] = c;
				continue;
			}
			for(i=0; i<escPps; i++) {
				int im = i*mapMax/eMapDen;
				double xx1 = pointsMap[temp_idx][im*5+0];
				double yy1 = pointsMap[temp_idx][im*5+1];
				double a1  = pointsMap[temp_idx][im*5+2];
				double x1  = pointsMap[temp_idx][im*5+3];
				double k1  = pointsMap[temp_idx][im*5+4];
				for(j=0; j<escPps; j++) {
					double xx2 = etp[j*5+0]-xx1;
					double yy2 = etp[j*5+1]-yy1;
					if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
							yy2 > gateAxisT || yy2 < -gateAxisT)) { ecost[i][j] = maxCost; continue; }
					double ddis = xx2*xx2+yy2*yy2;
					if (gateOn && ddis >= gateRadT) { ecost[i][j] = maxCost; continue; }
					double y2 = etp[j*5+2]-a1;
					double x2 = etp[j*5+3]-x1;
					double inside1 = y2*y2+x2*x2;
					if (inside1 > 2) inside1 = 4-inside1;
					double kdiff = etp[j*5+4]-k1;
					if (kdiff < 0) kdiff = -kdiff;
					double inside2 = inside1 * alpha + ddis * beta + kdiff * kappaGamma;
					inside1 = inside2*inside2;
					ecost[i][j] = inside1 > maxCost ? maxCost : inside1;
				}
			}
			double c;
			if (gSolver >= 2) {
				int eNeed = escPps - eOut; if (eNeed < 0) eNeed = 0;
				c = (regretMatch(ecost, escPps, eNeed, gSolver == 3)
				     + outlierCost * (eDim - eNeed)) / (double)eDim;
			} else {
				for (i=0;i<eDim;i++){ ersol[i]=i; ecsol[i]=i; euV[i]=0; evV[i]=0; }
				c = lap(eDim, ecost, ersol.data(), ecsol.data(), euV.data(), evV.data()) / (double)eDim;
			}
			nSolved++;
			if (c < eBest[ati]) { eSecond[ati] = eBest[ati]; eBest[ati] = c; }
			else if (c < eSecond[ati]) eSecond[ati] = c;
		}
	}
	// The two resolutions are NOT on the same scale (different assignment,
	// different /dim), and the caller turns costs into -log scores — so
	// dropping both into one vector would let a cheap-stage class outrank an
	// escalated one for no reason but resolution. Every escalated class has
	// BOTH numbers, so the query calibrates itself: shift the rest by the
	// median log-ratio on that overlap.
	std::vector<double> ratios;
	std::vector<double> escScore(nc, -1.0);
	for (size_t li=0; li<lead.size(); li++) {
		int ati = lead[li];
		if (eBest[ati] >= 1e30) continue;
		double sc = (eSecond[ati] >= 1e30) ? 0.9*eBest[ati]*eBest[ati]*eBest[ati]
		                                   : eBest[ati]*eBest[ati]*eSecond[ati];
		escScore[ati] = sc;
		double lo = gClassCost[ati];
		if (lo > 0 && lo < 1e29 && sc > 0) ratios.push_back(std::log(sc) - std::log(lo));
	}
	if (!ratios.empty()) {
		std::sort(ratios.begin(), ratios.end());
		double shift = std::exp(ratios[ratios.size()/2]);
		for (int ati=0; ati<nc; ati++)
			if (gClassCost[ati] < 1e29f) gClassCost[ati] = (float)(gClassCost[ati] * shift);
	}
	for (int ati=0; ati<nc; ati++) if (escScore[ati] >= 0) gClassCost[ati] = (float)escScore[ati];
	return nSolved;
}

int classCostsFromBounds(int test_digit, int test_sid, int pointsPerShape, int outliersMul,
                         double relax, int nClassesToScore, int keepClasses, int minPerClass) {
	return classCostsCore(test_digit, test_sid, pointsPerShape, outliersMul, relax,
	                      nClassesToScore, keepClasses, minPerClass, 0, 0, 0, 0);
}

/** Cheap pass at `cheapPps` + escalation of the top `topK` classes to `escPps`,
 *  all inside one call. The whole cascade for one query crosses the JS boundary
 *  exactly once, and — the reason it lives here rather than in JS — the main
 *  thread and the worker-pool lanes then run the SAME implementation. */
int classCostsCascade(int test_digit, int test_sid, int cheapPps, int escPps, int outliersMul,
                      double relax, int nClassesToScore, int keepClasses, int minPerClass,
                      int topK, int keepB, int maxSolve) {
	return classCostsCore(test_digit, test_sid, cheapPps, outliersMul, relax,
	                      nClassesToScore, keepClasses, minPerClass, topK, keepB, escPps, maxSolve);
}

/** Assignment cost of the CURRENT TEST INPUT (testMap, uploaded with m=-1)
 *  against one stored template — the raw per-template score surface for
 *  custom comparison plugins. Template side gets the same even subsampling
 *  as identify(); test side is read directly like identify(). denom = dim
 *  (the getSingleScore convention, not identify's continuity count). */
double getTestScore(int template_digit, int template_sid, int pointsPerShape, int outliersMul) {
	int i; int j;
	// testMap holds ppsMap points (a larger count used to read past its end)
	if (pointsPerShape > ppsMap) pointsPerShape = ppsMap;
	if (pointsPerShape < 1 || !slotOK(template_digit * shapesPerChar + template_sid)) return 1e30;
	int outliers = outlierCount(pointsPerShape, outliersMul);
	int dim = pointsPerShape+outliers;
	double** costMatrix;
	int *rowsol;
	int *colsol;
	double *u;
	double *v;
	rowsol = new int[dim];
	colsol = new int[dim];
	u = new double[dim];
	v = new double[dim];
	costMatrix = new double*[dim];
	for (i=0;i<dim;i++){
		rowsol[i]=i;
		colsol[i]=i;
		u[i]=0;
		v[i]=0;
		costMatrix[i] = new double[dim];
	}

	int temp_idx = template_digit * shapesPerChar + template_sid;
	int mapMax = ppsMap - 1;
	int mapDen = pointsPerShape > 1 ? pointsPerShape - 1 : 1;

	for(i=0; i<pointsPerShape; i++) {
		int im = i*mapMax/mapDen;
		double a1 = pointsMap[temp_idx][im*5+2];
		double x1 = pointsMap[temp_idx][im*5+3];
		double xx1 = pointsMap[temp_idx][im*5+0];
		double yy1 = pointsMap[temp_idx][im*5+1];
		double k1 = pointsMap[temp_idx][im*5+4];
		for(j=0; j<pointsPerShape; j++) {
			double xx2 = testMap[j*5+0]-xx1;
			double yy2 = testMap[j*5+1]-yy1;
			if (gateOn && (xx2 > gateAxisT || xx2 < -gateAxisT ||
					yy2 > gateAxisT || yy2 < -gateAxisT)) {
				costMatrix[i][j] = maxCost;
				continue;
			}
			double ddis = xx2*xx2+yy2*yy2;
			if (gateOn && ddis >= gateRadT) {
				costMatrix[i][j] = maxCost;
				continue;
			}

			double y2 = testMap[j*5+2]-a1;
			double x2 = testMap[j*5+3]-x1;
			double inside1 = y2*y2+x2*x2;

			if (inside1 > 2){
				inside1 = 4-inside1;
			}

			double kdiff = testMap[j*5+4]-k1;
			if (kdiff < 0) kdiff = -kdiff;
			double inside2 = inside1 * alpha + ddis * beta + kdiff * kappaGamma;
			inside1 = inside2*inside2;
			if ( inside1 > maxCost){
				costMatrix[i][j] = maxCost;
			}
			else {
				costMatrix[i][j] = inside1;
			}
		}
	}

	for (i=pointsPerShape;i<pointsPerShape+outliers;i++){
		for (j=0;j<pointsPerShape+outliers;j++){
			costMatrix[i][j] = outlierCost;
		}
	}
	for (i=0;i<pointsPerShape+outliers;i++){
		for (j=pointsPerShape;j<pointsPerShape+outliers;j++){
			costMatrix[i][j] = outlierCost;
		}
	}

	double cost = lapOutliers(dim, costMatrix, rowsol, colsol, u, v, outliers, outlierCost);

	double result = cost / dim;

	for (i=0;i<dim;i++){
		delete[] costMatrix[i];
	}
	delete[] costMatrix;
	delete[] rowsol;
	delete[] colsol;
	delete[] u;
	delete[] v;

	return result;
}
/** addPoint with a per-point curvature feature (5th slot). kappa should be
 *  scale-normalized and squashed to O(1) by the caller; it only affects
 *  matching when kappaGamma != 0 (setKappaGamma). */
void addPointK(int m,int j, double x, double y, double s, double c, double kappa){
	// A point or slot firstCall did not allocate is ignored (it used to be
	// written anyway, outside the arrays).
	if (j < 0 || j >= ppsMap || m >= (int)pointsMap.size()) return;
	// A NaN would make every comparison in the solver false; store 0 instead so
	// one bad coordinate cannot poison a whole match.
	if (!std::isfinite(x)) x = 0;
	if (!std::isfinite(y)) y = 0;
	if (!std::isfinite(s)) s = 0;
	if (!std::isfinite(c)) c = 0;
	if (!std::isfinite(kappa)) kappa = 0;
	if (m < 0){
		testMap[j*5+0]=x;
		testMap[j*5+1]=y;
		testMap[j*5+2]=s;
		testMap[j*5+3]=c;
		testMap[j*5+4]=kappa;
	}
	else {
		pointsMap[m][j*5+0]=x;
		pointsMap[m][j*5+1]=y;
		pointsMap[m][j*5+2]=s;
		pointsMap[m][j*5+3]=c;
		pointsMap[m][j*5+4]=kappa;
		if (j+1 == ppsMap){
			int i = m/shapesPerChar;
			int ii = m%shapesPerChar;
			if (ii+1 > spcMap[i]){
				spcMap[i]=ii+1;
			}
		}
	}
}
void addPoint(int m,int j, double x, double y, double s, double c){
	addPointK(m, j, x, y, s, c, 0);
}
/** Legacy tuning statistic: identify() accumulates the lowest (x=0) and
 *  second-lowest (x=1) per-class best cost of every call, each divided by 260. */
double getTotal(int x){
	return (x == 0 || x == 1) ? totalMin[x] : 0;
}
/** Cost of assigning a point to an outlier slot. firstCall resets it to 0
 *  (drops are free, the historical behavior); call after firstCall to tune. */
void setOutlierCost(double oc){
	outlierCost = oc;
}
/** Class-score combination (see comment in identify); call after firstCall. */
void setScoreMode(int m){
	scoreMode = m;
}
/** Weight of the per-point |kappa1-kappa2| curvature cost term. firstCall
 *  resets it to 0 (curvature ignored, the historical behavior). */
void setKappaGamma(double g){
	kappaGamma = g;
	recomputeGate();
}
/** Cost-gate radius as a fraction of the provable cap distance. 1 = exact
 *  (bit-identical output), <1 = aggressive (skips pairs that might not have
 *  capped), 0 = gate off. Call after firstCall. */
void setGateScale(double g){
	gateScale = g;
	recomputeGate();
}
/** 0 = square pre-test then circle, 1 = square only, 2 = circle only. */
void setGateMode(int m){
	gateMode = m;
	recomputeGate();
}
/** Set the parameters and allocate storage; call before anything else, and
 *  again to start over (every runtime knob returns to its default).
 *    a1, a2  alpha (direction weight) and beta (distance^2 weight)
 *    mc      maxCost, the cap on one pair's cost
 *    dc      divi: identify() abandons a template once the sum of its row
 *            minima passes maxCost*pointsPerShape/divi
 *    pps     points stored per shape      spc  template slots per class
 *    nc      classes (the batch entry points want one extra class whose slot 0
 *            holds the query) */
void firstCall(double a1, double a2, double mc, double dc, int pps, int spc, int nc){
	if (pps < 0) pps = 0;
	if (spc < 0) spc = 0;
	if (nc < 0) nc = 0;
	ppsMap = pps;
	shapesPerChar = spc;
	alpha = a1;
	beta = a2;
	outlierCost = 0;
	scoreMode = 0;
	kappaGamma = 0;
	maxCost = mc;
	divi = dc;
	// Default OFF, not 1.0: the exact gate is provably bit-identical but
	// MEASURED 7% SLOWER (90.3 vs 84.5 ms/char) — it swaps ~13 predictable
	// arithmetic ops for a data-dependent branch, and the branch costs more.
	// The win is the AGGRESSIVE setting: setGateScale(0.3) is 1.5x faster
	// with no measured accuracy change on MNIST (96.1 -> 96.3, n=1000);
	// accuracy is flat from 1.0 down to 0.3 and falls off sharply below 0.25.
	// Circle-only is the default SHAPE (a square pre-test measured no faster
	// and gates less; see MODE_PARAMS.gateScale for the radius). The gate is
	// OFF here so any caller that does not opt in keeps exact behaviour —
	// the shipped radii live in core/pipeline/constants.js because the safe
	// value is mode-dependent: stroke regresses at ANY aggressive setting
	// (outliersMul=1 leaves it far less slack to absorb gated pairs).
	gateScale = 0;
	gateMode = 2;
	recomputeGate();
	nchars = nc;
	totalMin[0] = 0;
	totalMin[1] = 0;
	pointsMap.resize(shapesPerChar * nchars);
	testMap.resize(ppsMap*5);
	spcMap.resize(nchars);
	int i;
	for (i=0;i<nchars;i++){
		spcMap[i]=0;
	}
	for (i=0;i<shapesPerChar * nchars;i++){
		pointsMap[i].resize(ppsMap*5);
	}
}
}
#ifndef MATCH_NO_MAIN
// Emscripten runs main() at module init and the NODE glue copies a nonzero
// return into process.exitCode, so any harness that boots the matcher in-thread
// used to exit 1 after printing PASS (the C++ never used the value).
int main() {
	return 0;
}
#endif

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_BINDINGS(my_module) {
    emscripten::function("firstCall", &firstCall);
	emscripten::function("addPoint", &addPoint);
	emscripten::function("addPointK", &addPointK);
	emscripten::function("getTotal", &getTotal);
	emscripten::function("setOutlierCost", &setOutlierCost);
	emscripten::function("setScoreMode", &setScoreMode);
	emscripten::function("setKappaGamma", &setKappaGamma);
	emscripten::function("setGateScale", &setGateScale);
	emscripten::function("setGateMode", &setGateMode);
	emscripten::function("identify", &identify);
	emscripten::function("identifyBatch", &identifyBatch);
// MILLIREC_LITE (scripts/build-wasm-lite.sh): the single-character library only
// ever calls firstCall/addPoint*/identify/identifyBatch/getTestScore and the
// runtime setters. Leaving the batch/cascade/GPU-bounds surface unbound lets
// the linker drop it, which is most of the wasm.
#ifndef MILLIREC_LITE
	emscripten::function("boundsPtr", &boundsPtr);
	emscripten::function("orderKeyPtr", &orderKeyPtr);
	emscripten::function("setOrderMode", &setOrderMode);
	emscripten::function("identifyFromBounds", &identifyFromBounds);
	emscripten::function("computeBounds", &computeBounds);
	emscripten::function("classCostsPtr", &classCostsPtr);
	emscripten::function("classCostsFromBounds", &classCostsFromBounds);
	emscripten::function("classCostsCascade", &classCostsCascade);
	emscripten::function("setSolver", &setSolver);
	emscripten::function("setWarmStart", &setWarmStart);
	emscripten::function("getSingleScore", &getSingleScore);
	emscripten::function("getScoresBatch", &getScoresBatch);
	emscripten::function("getScoresBatchPruned", &getScoresBatchPruned);
	emscripten::function("getScoresBatchGlobal", &getScoresBatchGlobal);
	emscripten::function("getScoresBatchGlobalMatch", &getScoresBatchGlobalMatch);
	emscripten::function("getScoresBatchGreedy", &getScoresBatchGreedy);
	emscripten::function("getScoresBatchGreedyMatch", &getScoresBatchGreedyMatch);
#endif // MILLIREC_LITE
#ifdef __EMSCRIPTEN_PTHREADS__
	emscripten::function("initThreads", &initThreads);
	emscripten::function("getScoresBatchGlobalMT", &getScoresBatchGlobalMT);
	emscripten::function("getScoresBatchPrunedMT", &getScoresBatchPrunedMT);
#endif
	emscripten::function("getTestScore", &getTestScore);
	emscripten::value_array<ArrayInStruct>("ArrayInStruct")
		.element(&ArrayInStruct::char1)
		.element(&ArrayInStruct::value1)
		.element(&ArrayInStruct::char2)
		.element(&ArrayInStruct::value2)
		.element(&ArrayInStruct::char3)
		.element(&ArrayInStruct::value3)
		.element(&ArrayInStruct::sid1)
		.element(&ArrayInStruct::sid2)
		.element(&ArrayInStruct::sid3);

}
#endif
