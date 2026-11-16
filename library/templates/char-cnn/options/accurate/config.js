// accurate: the most accurate, still fast and small
// 98.49% top-1, 0.24 ms mean via the kernel (worst case 0.9 ms), 20% escalated, 37 KB gzipped with the pad
window.MILLIREC_CNN = {
  "classes": "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "stages": [
    {
      "model": "tiny.bin",
      "head": "tiny.head.bin",
      "theta": 2.032
    },
    {
      "model": "base.q4.bin",
      "head": "base.head.bin"
    }
  ],
  "kernel": "cnn-web.js"
}
