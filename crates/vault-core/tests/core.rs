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
use vault_core::account::KeyKind;
use vault_core::scan::NextKeyIndices;
use vault_core::amount;
use vault_core::scan;
use vault_core::send::plan_inputs;
use vault_core::send::SendRequest;

fn account() -> Account {
    let words = Account::generate_phrase();
    Account::from_phrase(&words, Network::Main).unwrap()
}

#[test]
fn announcement_flags_cover_every_key_up_to_the_lookahead() {
    let mut account = account();
    let flags = scan::announcement_flags(&mut account, &NextKeyIndices::default());
    assert_eq!(flags.len(), 3 * (vault_core::account::KEY_LOOKAHEAD as usize + 1));
    let json = serde_json::to_string(&flags).unwrap();
    assert!(json.starts_with("[{\"flag\":"), "{json}");
    assert!(json.contains("\"receiver_id\":"), "{json}");
    let ids: std::collections::HashSet<u64> = flags.iter().map(|f| f.receiver_id.value()).collect();
    assert_eq!(ids.len(), flags.len(), "every key has its own identifier");
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
    let a = main.address(KeyKind::Generation, 0).unwrap();
    let t = test.address(KeyKind::Generation, 0).unwrap();
    assert!(a.starts_with("nolgam1"), "{a}");
    assert!(t.starts_with("nolgat1"), "{t}");
    assert!(main.parse_address(&a).is_ok());
    assert!(main.parse_address(&t).is_err(), "testnet address must not parse on mainnet");
    assert_ne!(main.address(KeyKind::Generation, 1).unwrap(), a);

    // The other kinds carry their own prefixes and are far shorter.
    let ech = main.address(KeyKind::EcHybrid, 0).unwrap();
    let view = main.address(KeyKind::Viewing, 0).unwrap();
    assert!(ech.starts_with("nechm1"), "{ech}");
    assert!(view.starts_with("nviewm1"), "{view}");
    assert!(ech.len() < 400 && view.len() < 400, "{} {}", ech.len(), view.len());
    assert!(main.parse_address(&ech).is_ok());
    assert!(main.parse_address(&view).is_ok());
    assert_ne!(main.address(KeyKind::EcHybrid, 1).unwrap(), ech);
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
    kernel_paying_kind(account, KeyKind::Generation, key_index, coins)
}

/// A kernel whose output this seed built: sender randomness derived the way
/// the wallet's own sends derive it, for `build_height`.
fn kernel_paying_from_self(account: &mut Account, key_index: u64, coins: &str, build_height: u64) -> (TransactionKernelProxy, Digest) {
    let key = account.key(KeyKind::Generation, key_index).clone();
    let address = key.to_address();
    let amount = amount::parse(coins).unwrap();
    let utxo = Utxo::new_native_currency(address.lock_script_hash(), amount);
    let sender_randomness = account
        .entropy()
        .generate_sender_randomness(build_height.into(), address.privacy_digest());
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

fn kernel_paying_kind(
    account: &mut Account,
    kind: KeyKind,
    key_index: u64,
    coins: &str,
) -> (TransactionKernelProxy, Digest) {
    let key = account.key(kind, key_index).clone();
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
        NextKeyIndices::default(),
        7,
        "00",
        1234,
    );
    assert!(spent.is_empty());
    assert_eq!(incoming.len(), 1);
    let found = &incoming[0];
    assert_eq!(found.hash, scan::coin_key(utxo_hash, 1000));
    assert_eq!(found.amount, "3.25");
    assert_eq!(found.key_kind, KeyKind::Generation);
    assert_eq!(found.key_index, 2);
    assert_eq!(found.recovery.aocl_index, 1000);
    assert_eq!(found.confirmed_height, 7);
    assert_eq!(next_key.generation, 3, "next unused key follows the highest key seen");
    assert_eq!(next_key.ec_hybrid, 0);
    assert_eq!(next_key.viewing, 0);

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
    assert_eq!(spent2, vec![scan::coin_key(utxo_hash, 1000)]);
}

/// A UTXO is only a lock script and an amount, so equal payments to one
/// address hash the same. Each must still be its own coin, whether the two
/// arrive in different blocks or in one transaction.
#[test]
fn equal_payments_to_one_address_are_separate_coins() {
    let mut account = account();
    let (first, utxo_hash) = kernel_paying(&mut account, 0, "1");
    let (second, _) = kernel_paying(&mut account, 0, "1");

    // Different blocks.
    let k1 = first.clone().into_kernel();
    let (in1, _, next) =
        scan::scan_kernel(&mut account, &k1, &k1.outputs.clone(), 500, &[], NextKeyIndices::default(), 7, "00", 1);
    let k2 = second.clone().into_kernel();
    let (in2, _, _) = scan::scan_kernel(&mut account, &k2, &k2.outputs.clone(), 900, &in1, next, 9, "01", 2);
    assert_eq!(in1.len(), 1);
    assert_eq!(in2.len(), 1);
    assert_eq!(in1[0].hash, scan::coin_key(utxo_hash, 500));
    assert_eq!(in2[0].hash, scan::coin_key(utxo_hash, 900));
    assert_ne!(in1[0].hash, in2[0].hash);
    assert_ne!(in1[0].absolute_index_set(), in2[0].absolute_index_set());

    // One transaction carrying both.
    let mut both = first;
    both.outputs.extend(second.outputs);
    both.announcements.extend(second.announcements);
    let kb = both.into_kernel();
    let (inb, _, _) =
        scan::scan_kernel(&mut account, &kb, &kb.outputs.clone(), 40, &[], NextKeyIndices::default(), 3, "02", 3);
    let keys: Vec<&str> = inb.iter().map(|u| u.hash.as_str()).collect();
    assert_eq!(keys, vec![scan::coin_key(utxo_hash, 40), scan::coin_key(utxo_hash, 41)]);

    // Spending the second leaves the first.
    let removal = RemovalRecord { absolute_indices: inb[1].absolute_index_set(), target_chunks: ChunkDictionary::default() };
    let spend = TransactionKernelProxy {
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
    let (_, spent, _) = scan::scan_kernel(&mut account, &spend, &[], 50, &inb, NextKeyIndices::default(), 4, "03", 4);
    assert_eq!(spent, vec![scan::coin_key(utxo_hash, 41)]);
}

#[test]
fn scan_ignores_announcements_for_other_wallets() {
    let mut ours = account();
    let mut theirs = account();
    let (proxy, _) = kernel_paying(&mut theirs, 0, "1");
    let kernel = proxy.into_kernel();
    let records = kernel.outputs.clone();
    let (incoming, _, next) =
        scan::scan_kernel(&mut ours, &kernel, &records, 0, &[], NextKeyIndices::default(), 1, "00", 0);
    assert!(incoming.is_empty());
    assert_eq!(next, NextKeyIndices::default());
}

#[test]
fn scan_finds_payments_to_ec_hybrid_and_viewing_addresses() {
    for kind in [KeyKind::EcHybrid, KeyKind::Viewing] {
        let mut account = account();
        let (proxy, utxo_hash) = kernel_paying_kind(&mut account, kind, 1, "0.5");
        let kernel = proxy.into_kernel();
        let records = kernel.outputs.clone();
        let (incoming, _, next) =
            scan::scan_kernel(&mut account, &kernel, &records, 0, &[], NextKeyIndices::default(), 1, "00", 0);
        assert_eq!(incoming.len(), 1, "{kind:?}");
        assert_eq!(incoming[0].hash, scan::coin_key(utxo_hash, 0));
        assert_eq!(incoming[0].key_kind, kind);
        assert_eq!(incoming[0].key_index, 1);
        assert_eq!(next.get(kind), 2, "{kind:?}");
        assert_eq!(next.generation, 0);
    }
}

#[test]
fn input_planning_picks_largest_first_and_reports_shortfall() {
    let mut account = account();
    let mut unspent = Vec::new();
    for (i, coins) in ["2", "1", "5"].iter().enumerate() {
        let (proxy, _) = kernel_paying(&mut account, 0, coins);
        let kernel = proxy.into_kernel();
        let records = kernel.outputs.clone();
        let (mut incoming, _, _) = scan::scan_kernel(
            &mut account,
            &kernel,
            &records,
            100 * i as u64,
            &[],
            NextKeyIndices::default(),
            i as u64,
            "00",
            0,
        );
        unspent.append(&mut incoming);
    }
    let request = SendRequest {
        recipient: String::new(),
        amount: "2.5".into(),
        fee: "0.1".into(),
        accept_lustration: false,
    };
    let plan = plan_inputs(&unspent, &request, 0).unwrap();
    // Largest first: 5 alone covers 2.6, so one input, one lock-script proof.
    assert_eq!(plan.inputs.len(), 1);
    assert_eq!(plan.inputs[0].amount, "5");
    assert_eq!(plan.absolute_index_sets.len(), 1);

    let more = SendRequest { amount: "5.5".into(), ..request.clone() };
    let plan = plan_inputs(&unspent, &more, 0).unwrap();
    assert_eq!(plan.inputs.iter().map(|u| u.amount.as_str()).collect::<Vec<_>>(), ["5", "2"]);

    let too_much = SendRequest { amount: "100".into(), ..request };
    let err = plan_inputs(&unspent, &too_much, 0).unwrap_err().to_string();
    assert!(err.contains("insufficient funds"), "{err}");
}

#[test]
fn mempool_kernel_reports_an_output_for_this_wallet() {
    let mut other = account();
    let mut account = account();
    let (proxy, _) = kernel_paying(&mut account, 2, "3.5");
    let kernel = proxy.into_kernel();
    let scan = scan::scan_mempool_kernel(&mut account, &kernel, &[], NextKeyIndices::default(), 0);
    assert_eq!(scan.incoming.len(), 1);
    assert_eq!(scan.incoming[0].amount, "3.5");
    assert_eq!(scan.incoming[0].key_kind, KeyKind::Generation);
    assert_eq!(scan.incoming[0].key_index, 2);
    assert_eq!(scan.incoming[0].commitment.len(), 80);
    assert_eq!(scan.incoming[0].commitment, kernel.outputs[0].canonical_commitment.to_hex());
    assert!(scan.spent.is_empty());

    // Not for us: a kernel paying a different wallet.
    let (proxy, _) = kernel_paying(&mut other, 0, "1");
    let scan = scan::scan_mempool_kernel(&mut account, &proxy.into_kernel(), &[], NextKeyIndices::default(), 0);
    assert!(scan.incoming.is_empty());
}

#[test]
fn own_outputs_are_recognised_by_their_sender_randomness() {
    let mut account = account();
    // Built against height 120, confirmed at 123: found within the window.
    let (proxy, _) = kernel_paying_from_self(&mut account, 1, "2", 120);
    let kernel = proxy.into_kernel();
    let records = kernel.outputs.clone();
    let (incoming, _, _) = scan::scan_kernel(&mut account, &kernel, &records, 0, &[], NextKeyIndices::default(), 123, "00", 0);
    assert_eq!(incoming.len(), 1);
    assert_eq!(incoming[0].own_build_height, Some(120));

    // Someone else's payment: no height matches.
    let (proxy, _) = kernel_paying(&mut account, 1, "2");
    let kernel = proxy.into_kernel();
    let records = kernel.outputs.clone();
    let (incoming, _, _) = scan::scan_kernel(&mut account, &kernel, &records, 0, &[], NextKeyIndices::default(), 123, "00", 0);
    assert_eq!(incoming[0].own_build_height, None);

    // The same in the mempool, against the current tip.
    let (proxy, _) = kernel_paying_from_self(&mut account, 1, "2", 500);
    let scan = scan::scan_mempool_kernel(&mut account, &proxy.into_kernel(), &[], NextKeyIndices::default(), 500);
    assert!(scan.incoming[0].own);
    let (proxy, _) = kernel_paying(&mut account, 1, "2");
    let scan = scan::scan_mempool_kernel(&mut account, &proxy.into_kernel(), &[], NextKeyIndices::default(), 500);
    assert!(!scan.incoming[0].own);
}

#[test]
fn key_derivation_is_deterministic_and_salted() {
    use vault_core::kdf::derive_key;
    use vault_core::kdf::MIN_M_KIB;
    use vault_core::kdf::MIN_T_COST;
    let a = derive_key(b"pw", b"0123456789abcdef", MIN_M_KIB, MIN_T_COST, 1).unwrap();
    let b = derive_key(b"pw", b"0123456789abcdef", MIN_M_KIB, MIN_T_COST, 1).unwrap();
    let c = derive_key(b"pw", b"fedcba9876543210", MIN_M_KIB, MIN_T_COST, 1).unwrap();
    assert_eq!(*a, *b);
    assert_ne!(*a, *c);
    assert!(derive_key(b"pw", b"short", MIN_M_KIB, MIN_T_COST, 1).is_err());
}

/// The parameters come from stored data and from backup files. A file must
/// not be able to hold the worker for hours, nor to have the app accept a
/// password hash that is cheap to guess against.
#[test]
fn key_derivation_refuses_parameters_out_of_range() {
    use vault_core::kdf::*;
    let salt = b"0123456789abcdef";
    for (m, t, p) in [
        (MIN_M_KIB - 1, MIN_T_COST, 1),
        (8, 1, 1),
        (MAX_M_KIB + 1, MIN_T_COST, 1),
        (3_000_000, 3, 1),
        (MIN_M_KIB, MIN_T_COST - 1, 1),
        (MIN_M_KIB, MAX_T_COST + 1, 1),
        (MIN_M_KIB, 4_000_000_000, 1),
        (MIN_M_KIB, MIN_T_COST, 0),
        (MIN_M_KIB, MIN_T_COST, MAX_P_COST + 1),
    ] {
        assert!(derive_key(b"pw", salt, m, t, p).is_err(), "memory {m}, passes {t}, lanes {p}");
    }
    assert!(derive_key(b"pw", &[7u8; 65], MIN_M_KIB, MIN_T_COST, 1).is_err());
    // The app's own default is inside the range.
    assert!((MIN_M_KIB..=MAX_M_KIB).contains(&DEFAULT_M_KIB));
    assert!((MIN_T_COST..=MAX_T_COST).contains(&DEFAULT_T_COST));
}
