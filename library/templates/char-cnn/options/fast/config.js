// fast: most accurate under 0.10 ms per character
// 97.77% top-1 on EMNIST uppercase (7,800 test images), 0.095 ms mean via the kernel, 5% escalated
window.MILLIREC_CNN = {
  "classes": "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "stages": [
    {
      "model": "tiny.bin",
      "head": "tiny.head.bin",
      "theta": 0.89
    },
    {
      "model": "base-p25.bin",
      "head": "base-p25.head.bin"
    }
  ],
  "kernel": "cnn-web.js"
}
