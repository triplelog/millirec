// small: most accurate under 10 KB gzipped
// 96.36% top-1, 0.89 ms in plain JS (0.06 ms with the kernel, which adds 16 KB), 8.0 KB gzipped with the pad-less runtime
window.MILLIREC_CNN = {
  "classes": "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "stages": [
    {
      "model": "tiny.bin",
      "head": "tiny.head.bin"
    }
  ]
}
