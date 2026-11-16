// assign.cpp — the assignment solver behind the matcher. Written for millirec
// (MIT, like the rest of the project); it replaces a third-party lap.cpp whose
// terms could not be established.
//
// THE PROBLEM. match.cpp builds an n x n matrix of pair costs between the
// points of a drawing and the points of a template (plus a few "outlier" rows
// and columns that let either side drop points), and wants the cheapest way to
// pair every row with a different column. Two things about how the answer is
// used shape this solver:
//
//   * Most templates are only being RULED OUT. The caller usually knows a
//     figure the total would have to beat to matter (the second-best so far);
//     for anything that cannot beat it, "at least that much" is the whole
//     answer. So the solver takes a `cutoff` and stops the moment it can prove
//     the optimum is not below it — often before pairing a single point.
//   * n is small (27 for a 25-point shape) and the matrix is dense, so plain
//     arrays and linear scans beat anything cleverer.
//
// THE METHOD is the textbook primal-dual one (shortest augmenting paths, in the
// family of Kuhn's Hungarian method and of Jonker & Volgenant 1987). Each row
// i and column j carries a price, u[i] and v[j], kept so that
//
//     u[i] + v[j] <= C[i][j]            for every pair            (feasible)
//
// Any complete pairing costs at least sum(u) + sum(v) — add the inequality
// over its pairs — so that sum is a LOWER BOUND on the optimum at every
// moment, and it only ever grows. That is what the cutoff is tested against.
// A pair is "tight" when the inequality is an equality; a pairing made only of
// tight pairs costs exactly sum(u) + sum(v) and is therefore optimal.
//
//   1. Start: v[j] = the cheapest entry of column j; u[i] = the cheapest
//      C[i][j] - v[j] in row i. Rows whose cheapest (tight) column is still
//      free take it.
//      THE OUTLIER ROWS AND COLUMNS need a start of their own. The matcher's
//      last `tail` rows and columns all hold one constant (the price of
//      dropping a point, usually 0), so every column's cheapest entry is that
//      constant, every row's cheapest column is an outlier column, and the
//      start above prices nothing: the bound begins at zero and nearly every
//      row is left for the path search. What the outliers really say is "the
//      `tail` worst rows may be dropped". So: T = the tail-th largest row
//      minimum; the outlier columns are priced at (constant - T), which makes
//      a row prefer dropping only if its cheapest partner costs T or more.
//      The same is done for the columns (S). The bound then STARTS at the sum
//      of all but the worst `tail` row minima plus what the columns add, and
//      most rows start paired.
//   2. Bidding. A row left over looks at its cheapest and second-cheapest
//      columns (by slack) and takes the cheapest, lowering that column's price
//      by the difference — the most it can lower it and still prefer the
//      column. Whoever held the column is now unpaired and bids in turn. This
//      is the auction idea (Bertsekas) with no minimum raise; it settles most
//      rows in a few cheap passes over a row each, but with no minimum raise
//      it can go round in circles on ties, so each row gets a fixed number of
//      bids and the rest are left for step 3.
//   3. For each row still left over, grow a tree of tight-or-nearly-tight
//      alternating paths from it (Dijkstra over the columns, on the slacks
//      C[i][j] - u[i] - v[j]) until a free column is reached; shift the prices
//      by the path lengths so everything on the path becomes tight, and flip
//      the path. Every such step pairs one more row and raises the lower bound
//      by the length of the path it found.
//
// The total returned for a completed solve is the sum of the chosen matrix
// entries, row by row — never the sum of the prices — so it carries no
// accumulated rounding.

#include <vector>

struct AssignResult {
	double cost;     // the optimum; or, when `rejected`, a lower bound on it that is >= cutoff
	bool rejected;   // true: stopped early, rowsol/colsol are NOT a complete pairing
};

static const double ASSIGN_INF = 1e300;
#ifndef ASSIGN_BIDS
#define ASSIGN_BIDS 3   // bids per row in step 2. Measured on real drill matrices (27 x 27): 3 bids 551 us per
                        // query against 638 with none; 1, 2 and 6 are within noise of 3.
#endif

/**
 * Cheapest pairing of n rows with n columns.
 *   C        n row pointers, each to n costs (finite)
 *   rowsol   out: rowsol[i] = the column paired with row i
 *   colsol   out: colsol[j] = the row paired with column j
 *   u, v     out: the row and column prices (see above)
 *   cutoff   stop as soon as the optimum is known to be >= cutoff
 *            (ASSIGN_INF: always solve to the end)
 *   tail, tailCost   the last `tail` rows and columns are all `tailCost`
 *            (the matcher's outliers); 0 when the matrix has no such border
 */
static AssignResult assignSolve(int n, double** C, int* rowsol, int* colsol, double* u, double* v, double cutoff, int tail = 0, double tailCost = 0) {
	AssignResult out; out.cost = 0; out.rejected = false;
	if (n <= 0) return out;

	// workspace, kept between calls
	static std::vector<double> distV;
	static std::vector<int> predV, todoV, freeV;
	if ((int)distV.size() < n) { distV.resize(n); predV.resize(n); todoV.resize(n); freeV.resize(n); }
	double* dist = distV.data();   // shortest slack-path length to each column
	int* pred = predV.data();      // the row that path reaches the column from
	int* todo = todoV.data();      // columns: [0, nDone) finished, [nDone, n) not yet
	int* freeRows = freeV.data();

	int i, j, k;

	// ---- 1. starting prices, and the pairs that cost nothing to make ----
	const int p = n - tail;   // the real rows and columns
	if (tail > 0 && p > 0) {
		// the k-th largest of a[0..p): k is tiny, so k passes of "largest below the last one found"
		// would mishandle repeats; keep the k largest seen so far instead (dist is free as scratch)
		auto kthLargest = [&](const double* a, int k) -> double {
			double* top = dist;   // top[0] >= top[1] >= ... the k largest so far
			int have = 0;
			for (int t = 0; t < p; t++) {
				const double x = a[t];
				if (have < k) { int q = have++; while (q > 0 && top[q - 1] < x) { top[q] = top[q - 1]; q--; } top[q] = x; }
				else if (x > top[k - 1]) { int q = k - 1; while (q > 0 && top[q - 1] < x) { top[q] = top[q - 1]; q--; } top[q] = x; }
			}
			return top[have - 1];
		};
		const int k = tail < p ? tail : p;
		// rows: what each real row pays its cheapest real column, capped at T
		for (i = 0; i < p; i++) {
			const double* Ci = C[i];
			double m = Ci[0];
			for (j = 1; j < p; j++) if (Ci[j] < m) m = Ci[j];
			u[i] = m;
		}
		const double T = kthLargest(u, k);
		for (i = 0; i < p; i++) if (u[i] > T) u[i] = T;
		// columns: what is left of each real column's cheapest entry once the rows are paid, capped at S
		for (j = 0; j < p; j++) {
			double m = C[0][j] - u[0];
			for (i = 1; i < p; i++) { const double x = C[i][j] - u[i]; if (x < m) m = x; }
			v[j] = m;
		}
		double S = kthLargest(v, k);
		if (S < tailCost - T) S = tailCost - T;   // an outlier row with an outlier column must stay feasible
		for (j = 0; j < p; j++) if (v[j] > S) v[j] = S;
		for (j = p; j < n; j++) v[j] = tailCost - T;
		for (j = 0; j < n; j++) colsol[j] = -1;
	} else {
		for (j = 0; j < n; j++) {
			double m = C[0][j];
			for (i = 1; i < n; i++) if (C[i][j] < m) m = C[i][j];
			v[j] = m;
			colsol[j] = -1;
		}
	}
	double bound = 0;
	for (j = 0; j < n; j++) bound += v[j];
	int nFree = 0;
	for (i = 0; i < n; i++) {
		const double* Ci = C[i];
		// the cheapest slack in the row, and the cheapest among columns still free
		double best = Ci[0] - v[0];
		int bestJ = 0;
		double bestOpen = ASSIGN_INF;
		int openJ = -1;
		if (colsol[0] < 0) { bestOpen = best; openJ = 0; }
		for (j = 1; j < n; j++) {
			double s = Ci[j] - v[j];
			if (s < best) { best = s; bestJ = j; }
			if (colsol[j] < 0 && s < bestOpen) { bestOpen = s; openJ = j; }
		}
		u[i] = best;
		bound += best;
		// a free column that is just as cheap is as good as the cheapest: take it
		if (openJ >= 0 && bestOpen <= best) bestJ = openJ;
		if (colsol[bestJ] < 0) { rowsol[i] = bestJ; colsol[bestJ] = i; }
		else { rowsol[i] = -1; freeRows[nFree++] = i; }
	}
	if (bound >= cutoff) { out.cost = bound; out.rejected = true; return out; }

	// ---- 2. bidding ----
	// freeRows is used as a queue: [head, nFree) wait to bid; a row that runs
	// out of bids, or cannot do better than tie with a held column, is kept in
	// [0, nLeft) for step 3. Every row gets ASSIGN_BIDS bids in total.
	if (nFree > 0) {
		static std::vector<int> bidsV, queueV;
		if ((int)bidsV.size() < n) bidsV.resize(n);
		int* bids = bidsV.data();
		for (i = 0; i < n; i++) bids[i] = 0;
		// the queue can grow: each bid may unseat one row, and there are at most n * ASSIGN_BIDS bids
		const int cap = n * (ASSIGN_BIDS + 1) + 1;
		if ((int)queueV.size() < cap) queueV.resize(cap);
		int* queue = queueV.data();
		int tail = 0, head = 0, nLeft = 0;
		for (k = 0; k < nFree; k++) queue[tail++] = freeRows[k];
		while (head < tail) {
			i = queue[head++];
			const double* Ci = C[i];
			// cheapest and second-cheapest slack (ignoring this row's own price)
			double w1 = Ci[0] - v[0], w2 = ASSIGN_INF;
			int j1 = 0;
			for (j = 1; j < n; j++) {
				const double s2 = Ci[j] - v[j];
				if (s2 < w1) { w2 = w1; w1 = s2; j1 = j; }
				else if (s2 < w2) w2 = s2;
			}
			if (n == 1) w2 = w1;
			int holder = colsol[j1];
			if (holder >= 0 && w2 <= w1) {
				// a tie for cheapest: a free column among the tied ones costs nothing to take
				for (j = 0; j < n; j++) if (colsol[j] < 0 && Ci[j] - v[j] <= w1) { j1 = j; holder = -1; break; }
			}
			if (holder >= 0 && (w2 <= w1 || bids[i] >= ASSIGN_BIDS)) {
				// taking it would only swap one unpaired row for another at no gain in price: leave it to step 3
				u[i] = w1;
				freeRows[nLeft++] = i;
				continue;
			}
			bids[i]++;
			u[i] = w2 < ASSIGN_INF ? w2 : w1;
			if (holder >= 0) v[j1] -= (w2 - w1);   // slack(i, j1) becomes 0; the holder's becomes w2 - w1 > 0
			else u[i] = w1;                         // a free column: no need to outbid anyone
			rowsol[i] = j1; colsol[j1] = i;
			if (holder >= 0) { rowsol[holder] = -1; queue[tail++] = holder; }
		}
		nFree = nLeft;
		bound = 0;
		for (i = 0; i < n; i++) bound += u[i] + v[i];
		if (nFree > 0 && bound >= cutoff) { out.cost = bound; out.rejected = true; return out; }
	}

	// ---- 3. one shortest augmenting path per row still unpaired ----
	for (int f = 0; f < nFree; f++) {
		const int start = freeRows[f];
		{
			const double* Cs = C[start];
			const double us = u[start];
			for (j = 0; j < n; j++) { dist[j] = Cs[j] - us - v[j]; pred[j] = start; todo[j] = j; }
		}
		int nDone = 0;        // todo[0..nDone) have their final distance
		int sink = -1;
		double reach = 0;     // distance of the column most recently finished
		while (sink < 0) {
			// the nearest unfinished column
			int at = nDone;
			double m = dist[todo[at]];
			for (k = nDone + 1; k < n; k++) { double d = dist[todo[k]]; if (d < m) { m = d; at = k; } }
			const int jj = todo[at];
			todo[at] = todo[nDone]; todo[nDone] = jj; nDone++;
			reach = m;
			const int owner = colsol[jj];
			if (owner < 0) { sink = jj; break; }
			// through its row to every other unfinished column
			const double* Co = C[owner];
			const double base = m - u[owner] - (Co[jj] - u[owner] - v[jj]);   // = m - slack(owner, jj) - u[owner]; the slack is 0 up to rounding
			for (k = nDone; k < n; k++) {
				const int c = todo[k];
				const double d = base + Co[c] - v[c];
				if (d < dist[c]) { dist[c] = d; pred[c] = owner; }
			}
		}
		// prices: every finished column (and its row) moves by how much sooner
		// than the sink it was reached, which keeps all pairs feasible and makes
		// the whole path tight
		for (k = 0; k < nDone - 1; k++) {
			const int c = todo[k];
			const double shift = reach - dist[c];
			v[c] -= shift;
			u[colsol[c]] += shift;
		}
		u[start] += reach;
		bound += reach;
		// flip the path back to the starting row
		for (j = sink; ; ) {
			const int r = pred[j];
			const int next = rowsol[r];
			colsol[j] = r; rowsol[r] = j;
			if (r == start) break;
			j = next;
		}
		if (bound >= cutoff && f + 1 < nFree) { out.cost = bound; out.rejected = true; return out; }
	}

	double total = 0;
	for (i = 0; i < n; i++) total += C[i][rowsol[i]];
	out.cost = total;
	return out;
}

/** The complete solve: every row paired, the optimal total returned. */
double lap(int dim, double** costmatrix, int* row, int* col, double* u, double* v) {
	return assignSolve(dim, costmatrix, row, col, u, v, ASSIGN_INF).cost;
}

/** The same for the matcher's matrices: the last `outliers` rows and columns are all `outlierCost`. */
double lapOutliers(int dim, double** costmatrix, int* row, int* col, double* u, double* v, int outliers, double outlierCost) {
	return assignSolve(dim, costmatrix, row, col, u, v, ASSIGN_INF, outliers, outlierCost).cost;
}
