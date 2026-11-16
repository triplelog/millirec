// lowercase: lowercase letters a–z, the accurate pair of networks
// 93.73% top-1 on strangers' lowercase (EMNIST, 7,800 test images), 20% escalated; 98.96% of the project's own writer's held-out drawings
window.MILLIREC_CNN = {
  "classes": "abcdefghijklmnopqrstuvwxyz",
  "stages": [
    {
      "model": "lowercase-tiny.bin",
      "head": "lowercase-tiny.head.bin",
      "theta": 1.177
    },
    {
      "model": "lowercase-base.q4.bin",
      "head": "lowercase-base.head.bin"
    }
  ],
  "kernel": "cnn-web.js"
}
