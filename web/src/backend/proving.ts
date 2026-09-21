// The parts of proving that are the same whoever runs it.
//
// Both provers run the same Rust over the same sub-proofs, so the cost model
// behind the progress bar and the error for a proof the person abandoned
// belong to neither of them in particular. How the work is started, watched
// and stopped is what differs, and that stays with each client.

/**
 * Relative cost of each sub-proof, from the Galaxy S24 measurement
 * (seconds, single thread): the removal-records integrity proof is most of
 * the work, the lock scripts almost none. Used only to move the bar in
 * proportion to work done, never to promise a time.
 */
const SUB_PROOF_WEIGHT: Array<[prefix: string, weight: number]> = [
  ['removal_records_integrity', 309],
  ['collect_lock_scripts', 15],
  ['kernel_to_outputs', 35],
  ['collect_type_scripts', 31],
  ['type_script', 63],
  ['lock_script', 3],
];

export function weightOf(name: string): number {
  return SUB_PROOF_WEIGHT.find(([prefix]) => name.startsWith(prefix))?.[1] ?? 30;
}

/** Total weight of a collection with `total` proofs, of which `inputs` are lock scripts. */
export function totalWeight(total: number, inputs: number): number {
  const fixed = 309 + 15 + 35 + 31;
  const locks = Math.max(0, Math.min(inputs, total - 4));
  const types = Math.max(0, total - 4 - locks);
  return fixed + locks * 3 + types * 63;
}

/** The proof was abandoned by the person. */
export class ProofCancelledError extends Error {
  constructor() {
    super('The proof was cancelled.');
    this.name = 'ProofCancelledError';
  }
}
