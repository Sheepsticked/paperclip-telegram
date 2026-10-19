// Runs async jobs one at a time, in order; a failing job rejects its own caller only.
export class SerialQueue {
  #tail = Promise.resolve();

  run(job) {
    const result = this.#tail.then(job);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  idle() {
    return this.#tail;
  }
}
