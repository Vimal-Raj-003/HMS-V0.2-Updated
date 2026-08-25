import { describe, expect, it } from 'vitest';
import {
  MLLP_CARRIAGE_RETURN,
  MLLP_END_BLOCK,
  MLLP_START_BLOCK,
  MllpDecoder,
  MllpFramingError,
  mllpFrame,
} from './mllp.js';

const MESSAGE = 'MSH|^~\\&|XN1000|LAB|VIMSHMS|VIMS|20260823||ORU^R01|C1|P|2.5.1\r';

describe('mllpFrame', () => {
  it('wraps a payload in <VT> … <FS><CR>', () => {
    const framed = mllpFrame(MESSAGE);
    expect(framed[0]).toBe(MLLP_START_BLOCK);
    expect(framed[framed.length - 2]).toBe(MLLP_END_BLOCK);
    expect(framed[framed.length - 1]).toBe(MLLP_CARRIAGE_RETURN);
    expect(framed.subarray(1, framed.length - 2).toString('utf8')).toBe(MESSAGE);
  });
});

describe('MllpDecoder', () => {
  it('decodes one whole frame', () => {
    const decoder = new MllpDecoder();
    const frames = decoder.push(mllpFrame(MESSAGE));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.toString('utf8')).toBe(MESSAGE);
  });

  it('decodes several frames arriving in one chunk', () => {
    const decoder = new MllpDecoder();
    const frames = decoder.push(Buffer.concat([mllpFrame('A'), mllpFrame('B'), mllpFrame('C')]));
    expect(frames.map((f) => f.toString('utf8'))).toEqual(['A', 'B', 'C']);
  });

  it('reassembles a frame split across three chunks', () => {
    // The failure this prevents is silent: an analyzer bursting forty results
    // delivers two and a half frames per `data` event, and a decoder that
    // assumed chunk boundaries were frame boundaries would lose every tail.
    const decoder = new MllpDecoder();
    const framed = mllpFrame(MESSAGE);
    expect(decoder.push(framed.subarray(0, 10))).toHaveLength(0);
    expect(decoder.push(framed.subarray(10, 40))).toHaveLength(0);
    const frames = decoder.push(framed.subarray(40));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.toString('utf8')).toBe(MESSAGE);
  });

  it('handles a chunk that ends between <FS> and <CR>', () => {
    const decoder = new MllpDecoder();
    const framed = mllpFrame('A');
    expect(decoder.push(framed.subarray(0, framed.length - 1))).toHaveLength(1);
    // The stray <CR> that follows must not be mistaken for the start of a frame.
    expect(decoder.push(framed.subarray(framed.length - 1))).toHaveLength(0);
  });

  it('accepts a frame with no trailing <CR>, which some analyzers omit', () => {
    const decoder = new MllpDecoder();
    const frames = decoder.push(
      Buffer.concat([Buffer.of(MLLP_START_BLOCK), Buffer.from('A'), Buffer.of(MLLP_END_BLOCK)]),
    );
    expect(frames.map((f) => f.toString('utf8'))).toEqual(['A']);
  });

  it('discards bytes before <VT> and counts them', () => {
    const decoder = new MllpDecoder();
    const frames = decoder.push(
      Buffer.concat([Buffer.from('junk from a half-written frame'), mllpFrame('A')]),
    );
    expect(frames.map((f) => f.toString('utf8'))).toEqual(['A']);
    expect(decoder.discardedBytes).toBe(30);
  });

  it('aborts a frame that never ends rather than growing until the process dies', () => {
    const decoder = new MllpDecoder({ maxFrameBytes: 64 });
    expect(() =>
      decoder.push(Buffer.concat([Buffer.of(MLLP_START_BLOCK), Buffer.alloc(128, 0x41)])),
    ).toThrowError(MllpFramingError);
    // The decoder is usable again afterwards: one bad peer must not end the day.
    expect(decoder.push(mllpFrame('A')).map((f) => f.toString('utf8'))).toEqual(['A']);
  });

  it('reports a partial frame as pending so a close can be seen as a truncation', () => {
    const decoder = new MllpDecoder();
    decoder.push(Buffer.concat([Buffer.of(MLLP_START_BLOCK), Buffer.from('MSH|^~')]));
    expect(decoder.pendingBytes).toBe(6);
    decoder.reset();
    expect(decoder.pendingBytes).toBe(0);
  });
});
