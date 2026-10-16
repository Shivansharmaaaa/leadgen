// AudioWorklet: forward raw microphone frames to the main thread.
// The capture AudioContext runs at 16 kHz, so frames arrive already at the
// rate Parakeet consumes and no resampling is needed.
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
