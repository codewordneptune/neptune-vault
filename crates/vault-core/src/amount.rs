//! Amount parsing and formatting, delegated to the consensus type so the
//! app never does its own decimal arithmetic.

use anyhow::anyhow;
use anyhow::Context;
use anyhow::Result;
use neptune_consensus::type_scripts::native_currency_amount::NativeCurrencyAmount;

/// Parse a user-entered amount in NPT (e.g. "1.25").
pub fn parse(text: &str) -> Result<NativeCurrencyAmount> {
    let amount =
        NativeCurrencyAmount::coins_from_str(text.trim()).context("not a valid amount")?;
    if amount.is_negative() {
        return Err(anyhow!("amount must not be negative"));
    }
    Ok(amount)
}

/// Parse an amount given in nau (the integer unit) as a decimal string.
pub fn from_nau_string(nau: &str) -> Result<NativeCurrencyAmount> {
    let nau: i128 = nau.trim().parse().context("not a valid nau amount")?;
    Ok(NativeCurrencyAmount::from_nau(nau))
}

pub fn to_nau_string(amount: NativeCurrencyAmount) -> String {
    amount.to_nau().to_string()
}

/// Display form: NPT with trailing zeros trimmed, at most 8 decimals.
pub fn format(amount: NativeCurrencyAmount) -> String {
    let s = amount.display_n_decimals(8);
    match s.find('.') {
        Some(_) => {
            let trimmed = s.trim_end_matches('0').trim_end_matches('.');
            if trimmed.is_empty() { "0".to_string() } else { trimmed.to_string() }
        }
        None => s,
    }
}
