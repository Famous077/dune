/**
 * The packed vector format and the similarity maths over it.
 *
 * One binary blob per repo, sharded across items by the caller:
 *
 *   'DVEC' | u32 version | u32 header length | header JSON | pad to 4 | float32 rows
 *
 * The header (embedder id, dimension, count, chunk ids in row order) travels inside the
 * blob, so the vectors can never be read without knowing what produced them. Floats are
 * little-endian, which every Lambda and developer architecture here is.
 */

import { EmbeddingSetHeaderSchema } from '@dune/shared';
import type { EmbeddingSetHeader } from '@dune/shared';

const MAGIC = 0x43455644; // 'DVEC' read as a little-endian u32
const VERSION = 1;
const PREAMBLE_BYTES = 12;

export interface VectorSet {
  header: EmbeddingSetHeader;
  vectors: Float32Array;
}

export function packVectors(set: VectorSet): Uint8Array {
  const { header, vectors } = set;
  if (vectors.length !== header.count * header.dimension) {
    throw new Error(`vector data holds ${vectors.length} floats, header says ${header.count} × ${header.dimension}`);
  }

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const dataOffset = Math.ceil((PREAMBLE_BYTES + headerBytes.byteLength) / 4) * 4;
  const packed = new Uint8Array(dataOffset + vectors.byteLength);

  const view = new DataView(packed.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, headerBytes.byteLength, true);
  packed.set(headerBytes, PREAMBLE_BYTES);
  packed.set(new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength), dataOffset);

  return packed;
}

export function unpackVectors(input: Uint8Array): VectorSet {
  // Copy so the float view is aligned; a concatenated Buffer can start at any offset.
  const bytes = input.slice();
  const view = new DataView(bytes.buffer);

  if (bytes.byteLength < PREAMBLE_BYTES || view.getUint32(0, true) !== MAGIC) {
    throw new Error('not a packed vector set');
  }
  const version = view.getUint32(4, true);
  if (version !== VERSION) throw new Error(`unsupported vector set version ${version}`);

  const headerLength = view.getUint32(8, true);
  const header = EmbeddingSetHeaderSchema.parse(
    JSON.parse(new TextDecoder().decode(bytes.subarray(PREAMBLE_BYTES, PREAMBLE_BYTES + headerLength))),
  );

  const dataOffset = Math.ceil((PREAMBLE_BYTES + headerLength) / 4) * 4;
  const floats = header.count * header.dimension;
  if (bytes.byteLength - dataOffset !== floats * 4) {
    throw new Error(`vector data is ${bytes.byteLength - dataOffset} bytes, expected ${floats * 4}`);
  }

  return { header, vectors: new Float32Array(bytes.buffer, dataOffset, floats) };
}

export interface Scored {
  chunkId: string;
  score: number;
}

/**
 * Cosine similarity of the query against every row, in row order. Computed in full rather
 * than assuming normalised vectors, so an embedder that does not normalise is still ranked
 * correctly. Retrieval needs every score, not just the top: the spread of the whole
 * distribution is one of its confidence signals.
 */
export function cosineScores(set: VectorSet, query: Float32Array): Float32Array {
  const { dimension, count } = set.header;
  if (query.length !== dimension) {
    throw new Error(`query vector has ${query.length} dimensions, the set has ${dimension}`);
  }

  let queryNorm = 0;
  for (let i = 0; i < dimension; i += 1) queryNorm += (query[i] ?? 0) ** 2;
  queryNorm = Math.sqrt(queryNorm);

  const scores = new Float32Array(count);
  for (let row = 0; row < count; row += 1) {
    const offset = row * dimension;
    let dot = 0;
    let norm = 0;
    for (let i = 0; i < dimension; i += 1) {
      const value = set.vectors[offset + i] ?? 0;
      dot += value * (query[i] ?? 0);
      norm += value * value;
    }
    const denominator = Math.sqrt(norm) * queryNorm;
    scores[row] = denominator === 0 ? 0 : dot / denominator;
  }
  return scores;
}

export function topKByCosine(set: VectorSet, query: Float32Array, k: number): Scored[] {
  const scores = cosineScores(set, query);
  return Array.from(scores, (score, row) => ({ chunkId: set.header.chunkIds[row] ?? '', score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
