export class TaskQueue {
  constructor({ concurrency = 4 } = {}) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  add(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.next();
    });
  }

  next() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.running += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.running -= 1;
          this.next();
        });
    }
  }
}
