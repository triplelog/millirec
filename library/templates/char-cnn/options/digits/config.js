// digits: digits 0–9, the accurate pair of networks
// 99.6% top-1 on strangers' digits (EMNIST, 3,000 test images), 20% escalated; 100% of the project's own writer's held-out drawings
window.MILLIREC_CNN = {
  "classes": "0123456789",
  "stages": [
    {
      "model": "digits-tiny.bin",
      "head": "digits-tiny.head.bin",
      "theta": 3.257
    },
    {
      "model": "digits-base.q4.bin",
      "head": "digits-base.head.bin"
    }
  ],
  "kernel": "cnn-web.js"
}
