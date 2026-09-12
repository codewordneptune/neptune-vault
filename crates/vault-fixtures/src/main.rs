//! Writes a deterministic, valid `PrimitiveWitness` with the requested number
//! of inputs and outputs, bincode-encoded, for the browser prover benchmark.
//!
//! Usage: vault-fixtures <out-file> [inputs] [outputs]

use anyhow::Context;
use anyhow::Result;
use neptune_consensus::transaction::primitive_witness::PrimitiveWitness;
use proptest::strategy::Strategy;
use proptest::strategy::ValueTree;
use proptest::test_runner::TestRunner;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let out = args
        .next()
        .context("usage: vault-fixtures <out-file> [inputs] [outputs]")?;
    let inputs: usize = args.next().map(|s| s.parse()).transpose()?.unwrap_or(1);
    let outputs: usize = args.next().map(|s| s.parse()).transpose()?.unwrap_or(2);

    let mut runner = TestRunner::deterministic();
    let witness = PrimitiveWitness::arbitrary_with_size_numbers(Some(inputs), outputs, 0)
        .new_tree(&mut runner)
        .map_err(|e| anyhow::anyhow!("strategy failed: {e}"))?
        .current();

    let bytes = bincode::serialize(&witness)?;
    std::fs::write(&out, &bytes).with_context(|| format!("writing {out}"))?;
    println!(
        "wrote {out}: {} bytes, {} inputs, {} outputs, {} lock scripts, {} type scripts",
        bytes.len(),
        witness.kernel.inputs.len(),
        witness.kernel.outputs.len(),
        witness.lock_scripts_and_witnesses.len(),
        witness.type_scripts_and_witnesses.len(),
    );
    Ok(())
}
