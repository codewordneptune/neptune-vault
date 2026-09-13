//! Native tests for the wallet core.

use neptune_consensus::transaction::announcement::Announcement;
use neptune_consensus::transaction::transaction_kernel::TransactionKernelProxy;
use neptune_consensus::transaction::utxo::Utxo;
use neptune_consensus::type_scripts::native_currency_amount::NativeCurrencyAmount;
use neptune_mutator_set::commit;
use neptune_mutator_set::removal_record::chunk_dictionary::ChunkDictionary;
use neptune_mutator_set::removal_record::RemovalRecord;
use neptune_primitives::network::Network;
use neptune_primitives::timestamp::Timestamp;
use neptune_wallet::tasm_lib::prelude::Digest;
use neptune_wallet::tasm_lib::prelude::Tip5;
use neptune_wallet::utxo_notification::UtxoNotificationPayload;
use num_traits::Zero;
use vault_core::account::Account;
use vault_core::amount;
use vault_core::scan;
use vault_core::send::plan_inputs;
use vault_core::send::SendRequest;

fn account() -> Account {
    let words = Account::generate_phrase();
    Account::from_phrase(&words, Network::Main).unwrap()
}

#[test]
fn phrase_round_trips_and_has_18_words() {
    let words = Account::generate_phrase();
    assert_eq!(words.len(), 18);
    let account = Account::from_phrase(&words, Network::Main).unwrap();
    assert_eq!(account.phrase(), words);
}

#[test]
fn addresses_carry_the_network_prefix_and_decode() {
    let words = Account::generate_phrase();
    let mut main = Account::from_phrase(&words, Network::Main).unwrap();
    let mut test = Account::from_phrase(&words, Network::Testnet(0)).unwrap();
    let a = main.address(0).unwrap();
    let t = test.address(0).unwrap();
    assert!(a.starts_with("nolgam1"), "{a}");
    assert!(t.starts_with("nolgat1"), "{t}");
    assert!(main.parse_address(&a).is_ok());
    assert!(main.parse_address(&t).is_err(), "testnet address must not parse on mainnet");
    assert_ne!(main.address(1).unwrap(), a);
}

#[test]
fn amounts_parse_and_format() {
    let one_and_a_half = amount::parse("1.5").unwrap();
    assert_eq!(amount::format(one_and_a_half), "1.5");
    let nau = amount::to_nau_string(one_and_a_half);
    assert_eq!(amount::format(amount::from_nau_string(&nau).unwrap()), "1.5");
    assert_eq!(amount::format(amount::parse("0").unwrap()), "0");
    assert!(amount::parse("-1").is_err());
    assert!(amount::parse("abc").is_err());
}

/// Build a kernel with one announced output to `account`'s key `key_index`
/// and return it with its addition record.
fn kernel_paying(account: &mut Account, key_index: u64, coins: &str) -> (TransactionKernelProxy, Digest) {
    let key = account.key(key_index).clone();
    let address = key.to_address();
    let amount = amount::parse(coins).unwrap();
    let utxo = Utxo::new_native_currency(address.lock_script_hash(), amount);
    let sender_randomness = Digest::default();
    let payload = UtxoNotificationPayload::new(utxo.clone(), sender_randomness);
    let announcement: Announcement = address.generate_announcement(payload);
    let addition_record = commit(Tip5::hash(&utxo), sender_randomness, address.privacy_digest());
    let proxy = TransactionKernelProxy {
        inputs: vec![],
        outputs: vec![addition_record],
        announcements: vec![announcement],
        fee: NativeCurrencyAmount::zero(),
        coinbase: None,
        timestamp: Timestamp::now(),
        mutator_set_hash: Digest::default(),
        merge_bit: false,
    };
    (proxy, Tip5::hash(&utxo))
}

#[test]
fn scan_finds_announced_utxo_then_its_spend() {
    let mut account = account();
    let (proxy, utxo_hash) = kernel_paying(&mut account, 2, "3.25");
    let kernel = proxy.into_kernel();
    let addition_records = kernel.outputs.clone();

    let (incoming, spent, next_key) = scan::scan_kernel(
        &mut account,
        &kernel,
        &addition_records,
        1000,
        &[],
        0,
        7,
        "00",
        1234,
    );
    assert!(spent.is_empty());
    assert_eq!(incoming.len(), 1);
    let found = &incoming[0];
    assert_eq!(found.hash, utxo_hash.to_hex());
    assert_eq!(found.amount, "3.25");
    assert_eq!(found.key_index, 2);
    assert_eq!(found.recovery.aocl_index, 1000);
    assert_eq!(found.confirmed_height, 7);
    assert_eq!(next_key, 3, "next unused key follows the highest key seen");

    // A later kernel whose removal record carries our absolute index set.
    let removal = RemovalRecord {
        absolute_indices: found.absolute_index_set(),
        target_chunks: ChunkDictionary::default(),
    };
    let spend_kernel = TransactionKernelProxy {
        inputs: vec![removal],
        outputs: vec![],
        announcements: vec![],
        fee: NativeCurrencyAmount::zero(),
        coinbase: None,
        timestamp: Timestamp::now(),
        mutator_set_hash: Digest::default(),
        merge_bit: false,
    }
    .into_kernel();
    let (incoming2, spent2, _) =
        scan::scan_kernel(&mut account, &spend_kernel, &[], 2000, &incoming, next_key, 8, "01", 1235);
    assert!(incoming2.is_empty());
    assert_eq!(spent2, vec![utxo_hash.to_hex()]);
}

#[test]
fn scan_ignores_announcements_for_other_wallets() {
    let mut ours = account();
    let mut theirs = account();
    let (proxy, _) = kernel_paying(&mut theirs, 0, "1");
    let kernel = proxy.into_kernel();
    let records = kernel.outputs.clone();
    let (incoming, _, next) = scan::scan_kernel(&mut ours, &kernel, &records, 0, &[], 0, 1, "00", 0);
    assert!(incoming.is_empty());
    assert_eq!(next, 0);
}

#[test]
fn input_planning_picks_oldest_first_and_reports_shortfall() {
    let mut account = account();
    let mut unspent = Vec::new();
    for (i, coins) in ["2", "1", "5"].iter().enumerate() {
        let (proxy, _) = kernel_paying(&mut account, 0, coins);
        let kernel = proxy.into_kernel();
        let records = kernel.outputs.clone();
        let (mut incoming, _, _) =
            scan::scan_kernel(&mut account, &kernel, &records, 100 * i as u64, &[], 0, i as u64, "00", 0);
        unspent.append(&mut incoming);
    }
    let request = SendRequest {
        recipient: String::new(),
        amount: "2.5".into(),
        fee: "0.1".into(),
        accept_lustration: false,
    };
    let plan = plan_inputs(&unspent, &request, 0).unwrap();
    // Oldest (lowest aocl index) first: 2 then 1 covers 2.6.
    assert_eq!(plan.inputs.len(), 2);
    assert_eq!(plan.inputs[0].amount, "2");
    assert_eq!(plan.inputs[1].amount, "1");
    assert_eq!(plan.membership_proof_request.absolute_index_sets.len(), 2);

    let too_much = SendRequest { amount: "100".into(), ..request };
    let err = plan_inputs(&unspent, &too_much, 0).unwrap_err().to_string();
    assert!(err.contains("insufficient funds"), "{err}");
}

#[test]
fn key_derivation_is_deterministic_and_salted() {
    let a = vault_core::kdf::derive_key(b"pw", b"0123456789abcdef", 8 * 1024, 1, 1).unwrap();
    let b = vault_core::kdf::derive_key(b"pw", b"0123456789abcdef", 8 * 1024, 1, 1).unwrap();
    let c = vault_core::kdf::derive_key(b"pw", b"fedcba9876543210", 8 * 1024, 1, 1).unwrap();
    assert_eq!(*a, *b);
    assert_ne!(*a, *c);
    assert!(vault_core::kdf::derive_key(b"pw", b"short", 8 * 1024, 1, 1).is_err());
}
