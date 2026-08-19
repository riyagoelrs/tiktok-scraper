// Collects mono float samples into fixed-size frames and ships them to the
// renderer. Runs on the audio thread, so it does nothing but copy.
const FRAME = 2048;

class PcmCollector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(FRAME);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      this.buffer[this.filled] = channel[i];
      this.filled += 1;
      if (this.filled === FRAME) {
        const frame = this.buffer.slice(0);
        this.port.postMessage(frame, [frame.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-collector', PcmCollector);
