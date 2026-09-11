// WebRTC peer for codex realtime (webrtc transport)
// mic PCM(48kHz s16 mono) -> opus -> RTP out ; inbound RTP -> opus decode -> PCM16 out
import { RTCPeerConnection, MediaStreamTrack, RtpPacket } from "werift";
import OpusScript from "opusscript";

const SAMPLE_RATE = 48000;
const FRAME = 960; // 20ms @ 48kHz

export class LivePeer {
  constructor({ onAudioPcm = () => {}, onEvent = () => {}, log = console.log } = {}) {
    this.log = log;
    this.onAudioPcm = onAudioPcm;
    this.onEvent = onEvent;
    this.enc = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.AUDIO);
    this.dec = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.AUDIO);
    this.seq = Math.floor(Math.random() * 0xffff);
    this.ts = Math.floor(Math.random() * 0xffffffff) >>> 0;
  }

  async createOffer() {
    this.pc = new RTCPeerConnection();
    this.track = new MediaStreamTrack({ kind: "audio" });
    this.transceiver = this.pc.addTransceiver(this.track, { direction: "sendrecv" });
    this.dc = this.pc.createDataChannel("oai-events");
    this.dc.onMessage.subscribe?.((msg) => this.onEvent(msg));
    this.dc.onmessage = (ev) => this.onEvent(ev?.data ?? ev);

    this.transceiver.receiver.track.onReceiveRtp.subscribe(({ packet }) => {
      try {
        const pcm = this.dec.decode(packet.payload, FRAME);
        this.onAudioPcm(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      } catch {}
    });

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    // wait for ICE gathering to finish so the offer carries candidates
    await new Promise((res) => {
      if (this.pc.iceGatheringState === "complete") return res();
      const iv = setInterval(() => {
        if (this.pc.iceGatheringState === "complete") { clearInterval(iv); res(); }
      }, 50);
      setTimeout(res, 5000); // don't hang forever
    });
    return this.pc.localDescription.sdp;
  }

  async setAnswer(sdp) {
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    this.log("[rtc] remote description set");
  }

  // feed 48kHz mono s16le PCM. Real-time pacing handled by caller or internal timer.
  async streamPcm(pcmBuffer, { realtime = true } = {}) {
    const ssrc = this.transceiver.sender.ssrc;
    for (let off = 0; off + FRAME * 2 <= pcmBuffer.length; off += FRAME * 2) {
      const frame = pcmBuffer.subarray(off, off + FRAME * 2);
      const opus = this.enc.encode(frame, FRAME);
      const pkt = new RtpPacket({
        header: {
          version: 2, padding: false, extension: false, marker: off === 0,
          payloadType: 111, sequenceNumber: this.seq = (this.seq + 1) & 0xffff,
          timestamp: this.ts = (this.ts + FRAME) >>> 0, ssrc,
        },
        payload: opus,
      });
      this.track.writeRtp(pkt);
      if (realtime) await new Promise((r) => setTimeout(r, 20));
    }
  }

  async close() { try { await this.pc?.close(); } catch {} }
}
