//! Each operation on its own, and the interleavings the engine exists to
//! make harmless. The app's end-to-end behaviour is held to account by its
//! own tests, which run against this code compiled to wasm.

use neptune_consensus::transaction::utxo::Utxo as ChainUtxo;
use neptune_consensus::type_scripts::native_currency_amount::NativeCurrencyAmount;
use neptune_wallet::incoming_utxo::IncomingUtxoRecoveryData;
use neptune_wallet::tasm_lib::prelude::Digest;

use super::*;

const W: &str = "w";

fn coin(hash: &str, amount: i128, height: u64) -> StoredUtxo {
    StoredUtxo {
        hash: hash.into(),
        commitment: format!("cm-{hash}"),
        recovery: IncomingUtxoRecoveryData {
            utxo: ChainUtxo::new_native_currency(Digest::default(), NativeCurrencyAmount::from_nau(amount)),
            sender_randomness: Digest::default(),
            receiver_preimage: Digest::default(),
            aocl_index: height,
        },
        amount_nau: amount.to_string(),
        amount: amount.to_string(),
        key_kind: Default::default(),
        key_index: 0,
        release_date_ms: None,
        confirmed_height: height,
        confirmed_block: format!("h{height}"),
        confirmed_timestamp_ms: height * 10,
        own_build_height: None,
    }
}

fn block(height: u64, incoming: Vec<StoredUtxo>, spent: &[&str], seen: &[&str]) -> ScannedBlock {
    ScannedBlock {
        height,
        hash: format!("h{height}"),
        prev_hash: format!("h{}", height - 1),
        timestamp_ms: height * 10,
        incoming,
        spent: spent.iter().map(|s| s.to_string()).collect(),
        seen: seen.iter().map(|s| s.to_string()).collect(),
    }
}

fn wallet() -> WalletState {
    WalletState {
        scan: Some(ScanState { birthday_height: 100, next_key_indices: FRESH_KEY_INDICES, restore: None, restored_at: None }),
        ..Default::default()
    }
}

/// Run an operation against the wallet as it is, and apply what it decided,
/// as the worker does once it is written down.
fn run<T>(state: &mut WalletState, op: impl FnOnce(&WalletState) -> Outcome<T>) -> T {
    let outcome = op(state);
    state.apply(outcome.changes);
    outcome.value
}

fn persist(state: &mut WalletState, blocks: &[ScannedBlock]) {
    let indices = next_key_indices(state).unwrap();
    run(state, |s| persist_scan(s, W, blocks, indices, KEEP_BLOCKS, 7).unwrap());
}

fn pending_send(txid: &str, inputs: &[&str], outputs: &[&str]) -> HistoryEntry {
    history_entry(json!({
        "key": format!("{W}:sent:{txid}"), "accountId": W, "kind": "sent", "status": "pending", "txid": txid,
        "amountNau": "5", "feeNau": "1", "timestampMs": 1, "height": null, "inputHashes": inputs,
        "recipient": "nolgam1payee", "error": null, "changeNau": null,
        "outputs": outputs.iter().enumerate().map(|(i, c)| json!({ "commitment": c, "role": if i == 0 { "recipient" } else { "change" } })).collect::<Vec<_>>()
    }))
    .unwrap()
}

fn row(state: &WalletState, key: &str) -> Value {
    serde_json::to_value(&state.history[&format!("{W}:{key}")]).unwrap()
}

// ------------------------------------------------------------------ the sync

#[test]
fn a_new_coin_is_written_with_its_receipt_in_the_app_s_own_shape() {
    let mut state = wallet();
    let mut incoming = Map::new();
    incoming.insert("key".into(), json!("w:incoming:cm-a"));
    state.history.insert("w:incoming:cm-a".into(), HistoryEntry {
        key: "w:incoming:cm-a".into(), kind: "received".into(), status: "pending".into(), txid: "t".into(),
        timestamp_ms: 1, height: None, input_hashes: vec![], extra: incoming,
    });
    persist(&mut state, &[block(120, vec![coin("a", 5000, 120)], &[], &[])]);

    let utxo = serde_json::to_value(&state.utxos["a"]).unwrap();
    assert_eq!(utxo["key"], json!("w:a"));
    assert_eq!(utxo["accountId"], json!(W));
    assert_eq!(utxo["amountNau"], json!("5000"));
    assert_eq!(utxo["releaseDateMs"], Value::Null);
    assert_eq!(utxo["stored"]["hash"], json!("a"));

    let receipt = row(&state, "recv:a");
    assert_eq!((receipt["status"].clone(), receipt["height"].clone(), receipt["feeNau"].clone()), (json!("confirmed"), json!(120), Value::Null));
    assert!(!state.history.contains_key("w:incoming:cm-a"), "the mempool's row for the same output goes");
    assert_eq!(state.sync.as_ref().unwrap().synced_height, 120);
    assert_eq!(serde_json::to_value(&state.blocks[&120]).unwrap()["key"], json!("w:120"));
}

#[test]
fn a_spend_that_carries_the_send_s_own_outputs_confirms_it() {
    let mut state = wallet();
    persist(&mut state, &[block(120, vec![coin("a", 5000, 120)], &[], &[])]);
    run(&mut state, |s| record_pending(s, pending_send("tx1", &["a"], &["out1", "chg1"])));
    assert_eq!(state.utxos["a"].pending_txid.as_deref(), Some("tx1"));

    persist(&mut state, &[block(121, vec![], &["a"], &["out1"])]);
    let a = &state.utxos["a"];
    assert_eq!((a.spent_height, a.spent_txid.as_deref(), a.pending_txid.as_deref()), (Some(121), Some("tx1"), Some("tx1")));
    assert_eq!(row(&state, "sent:tx1")["status"], json!("confirmed"));
    assert_eq!(row(&state, "sent:tx1")["height"], json!(121));
}

#[test]
fn a_send_whose_coins_went_in_another_transaction_fails_and_lets_go_of_the_rest() {
    let mut state = wallet();
    persist(&mut state, &[block(120, vec![coin("a", 5000, 120), coin("b", 3000, 120)], &[], &[])]);
    run(&mut state, |s| record_pending(s, pending_send("tx1", &["a", "b"], &["out1"])));

    // Another device with the same phrase spent a, and got 1000 back as change.
    let mut change = coin("c", 1000, 121);
    change.own_build_height = Some(120);
    persist(&mut state, &[block(121, vec![change], &["a"], &["someone-else"])]);

    let sent = row(&state, "sent:tx1");
    assert_eq!(sent["status"], json!("failed"));
    assert!(sent["error"].as_str().unwrap().contains("made elsewhere with this seed phrase"));
    assert_eq!(state.utxos["b"].pending_txid, None, "what else it held is free again");
    assert_eq!(state.utxos["a"].spent_txid, None);

    let elsewhere = row(&state, "spent:121");
    assert_eq!(elsewhere["amountNau"], json!("4000"));
    assert_eq!(elsewhere["changeNau"], json!("1000"));
    assert_eq!(elsewhere["outputs"], json!([{ "commitment": "cm-c", "role": "change" }]));
}

#[test]
fn a_block_written_again_keeps_what_is_known_and_a_coin_written_afresh_is_held_again() {
    let mut state = wallet();
    persist(&mut state, &[block(120, vec![coin("a", 5000, 120)], &[], &[])]);
    persist(&mut state, &[block(125, vec![], &["a"], &[])]);
    // A fast restore looks at block 120 again.
    persist(&mut state, &[block(120, vec![coin("a", 5000, 120)], &[], &[])]);
    assert_eq!(state.utxos["a"].spent_height, Some(125), "still spent");

    // A pending send holds coin b, which a rollback took away; the rescan brings it back.
    run(&mut state, |s| record_pending(s, pending_send("tx2", &["b"], &["o"])));
    persist(&mut state, &[block(130, vec![coin("b", 1, 130)], &[], &[])]);
    assert_eq!(state.utxos["b"].pending_txid.as_deref(), Some("tx2"));
}

#[test]
fn old_blocks_are_trimmed_and_the_key_counters_move_with_the_coins() {
    let mut state = wallet();
    let blocks: Vec<_> = (101..=105).map(|h| block(h, vec![], &[], &[])).collect();
    let mut indices = FRESH_KEY_INDICES;
    indices.generation = 4;
    let outcome = persist_scan(&state, W, &blocks, indices, 2, 7).unwrap();
    run(&mut state, |_| outcome);
    assert_eq!(state.blocks.keys().copied().collect::<Vec<_>>(), [104, 105]);
    assert_eq!(state.scan.as_ref().unwrap().next_key_indices.generation, 4);
    // Unchanged counters write nothing for them.
    let again = persist_scan(&state, W, &[block(106, vec![], &[], &[])], indices, 2, 7).unwrap();
    assert!(!again.changes.iter().any(|c| matches!(c, WalletChange::PutScan { .. })));
}

#[test]
fn a_rollback_forgets_what_was_above_and_puts_own_sends_back_to_pending() {
    let mut state = wallet();
    persist(&mut state, &[block(120, vec![coin("a", 5, 120)], &[], &[])]);
    run(&mut state, |s| record_pending(s, pending_send("tx1", &["a"], &["out1"])));
    persist(&mut state, &[block(121, vec![coin("b", 7, 121)], &["a"], &["out1"])]);

    run(&mut state, |s| roll_back(s, W, 120, Some("h120".into()), 9));
    assert!(!state.utxos.contains_key("b"), "a coin found above goes");
    assert_eq!(state.utxos["a"].spent_height, None, "a spend above is undone");
    assert!(!state.history.contains_key("w:recv:b"));
    assert_eq!(row(&state, "sent:tx1")["status"], json!("pending"));
    assert_eq!(row(&state, "sent:tx1")["height"], Value::Null);
    assert_eq!(state.blocks.keys().copied().collect::<Vec<_>>(), [120]);
    assert_eq!(state.sync.as_ref().unwrap().synced_height, 120);

    // Rolling back to before the first block leaves nothing and a position of -1.
    run(&mut state, |s| roll_back(s, W, -1, None, 9));
    assert!(state.blocks.is_empty() && state.utxos.is_empty());
    assert_eq!(state.sync.as_ref().unwrap().synced_height, -1);
}

#[test]
fn the_start_height_is_set_once_from_the_tip_and_never_lowered_afterwards() {
    let mut unknown = wallet();
    unknown.scan.as_mut().unwrap().birthday_height = 0;
    let position = run(&mut unknown, |s| start_pass(s, 500).unwrap());
    assert_eq!((unknown.scan.as_ref().unwrap().birthday_height, position.synced_height), (500, 499));

    let mut ahead = wallet();
    ahead.scan.as_mut().unwrap().birthday_height = 900;
    run(&mut ahead, |s| start_pass(s, 500).unwrap());
    assert_eq!(ahead.scan.as_ref().unwrap().birthday_height, 500);

    let mut scanned = wallet();
    persist(&mut scanned, &[block(450, vec![], &[], &[])]);
    scanned.scan.as_mut().unwrap().birthday_height = 900;
    let outcome = start_pass(&scanned, 500).unwrap();
    assert!(outcome.changes.is_empty(), "a wallet with a position keeps its start height");
    assert_eq!(outcome.value, Position { synced_height: 450, synced_hash: Some("h450".into()) });

    let error = start_pass(&scanned, 400).unwrap_err().to_string();
    assert!(error.contains("ends at block 400, below block 450"), "{error}");
}

#[test]
fn fork_candidates_are_the_kept_blocks_below_the_position_oldest_first() {
    let mut state = wallet();
    persist(&mut state, &(101..=104).map(|h| block(h, vec![], &[], &[])).collect::<Vec<_>>());
    assert_eq!(fork_candidates(&state, 104).iter().map(|(h, _)| *h).collect::<Vec<_>>(), [101, 102, 103]);
    assert_eq!(rollback_floor(&state).unwrap(), 99);
}

#[test]
fn a_fast_restore_hands_over_below_the_tip_and_a_rescan_starts_from_nothing() {
    let mut state = wallet();
    state.scan.as_mut().unwrap().restore = Some("fast".into());
    persist(&mut state, &[block(300, vec![coin("a", 5, 300)], &[], &[])]);
    run(&mut state, |s| finish_fast_restore(s, W, 990, 300, 42).unwrap());
    let scan = state.scan.clone().unwrap();
    assert_eq!((scan.restore, scan.restored_at, scan.birthday_height), (None, Some(42), 300));
    assert_eq!(state.sync.as_ref().unwrap().synced_height, 990);

    state.contacts.insert("k".into(), serde_json::from_value(json!({ "id": "k", "name": "Al", "address": "x" })).unwrap());
    run(&mut state, |s| reset_for_rescan(s, 250, true).unwrap());
    assert!(state.utxos.is_empty() && state.history.is_empty() && state.sync.is_none());
    assert_eq!(state.contacts.len(), 1, "what a person made stays");
    let scan = state.scan.unwrap();
    assert_eq!((scan.birthday_height, scan.next_key_indices, scan.restore.as_deref()), (250, FRESH_KEY_INDICES, Some("fast")));
}

// ------------------------------------------------------------------ sends

#[test]
fn spendable_leaves_out_what_is_spent_held_or_still_locked() {
    let mut state = wallet();
    let mut locked = coin("l", 1, 120);
    locked.release_date_ms = Some(5_000);
    persist(&mut state, &[block(120, vec![coin("a", 1, 120), coin("h", 1, 120), coin("s", 1, 120), locked], &[], &[])]);
    persist(&mut state, &[block(121, vec![], &["s"], &[])]);
    run(&mut state, |s| record_pending(s, pending_send("tx", &["h"], &["o"])));
    let hashes = |now| spendable(&state, now).iter().map(|v| v["hash"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(hashes(1_000), ["a"]);
    assert_eq!(hashes(5_000), ["a", "l"]);
}

#[test]
fn a_refused_send_disappears_and_one_given_up_on_is_kept_as_failed() {
    let mut state = wallet();
    persist(&mut state, &[block(120, vec![coin("a", 1, 120), coin("b", 1, 120)], &[], &[])]);
    run(&mut state, |s| record_pending(s, pending_send("tx1", &["a"], &["o1"])));
    run(&mut state, |s| record_pending(s, pending_send("tx2", &["b"], &["o2"])));

    run(&mut state, |s| discard_pending(s, W, "tx1"));
    assert!(!state.history.contains_key("w:sent:tx1"));
    assert_eq!(state.utxos["a"].pending_txid, None);

    run(&mut state, |s| forget_send(s, W, "tx2"));
    assert_eq!(row(&state, "sent:tx2")["status"], json!("failed"));
    assert_eq!(row(&state, "sent:tx2")["error"], json!("You gave up on this send."));
    assert_eq!(state.utxos["b"].pending_txid, None);
    assert!(forget_send(&state, W, "nothing").changes.is_empty());
}

// ------------------------------------------------------------------ the mempool

fn outgoing(txid: &str, inputs: &[&str]) -> HistoryEntry {
    history_entry(json!({
        "key": format!("{W}:outgoing:{}", inputs[0]), "accountId": W, "kind": "sent", "status": "pending", "txid": txid,
        "amountNau": "1", "feeNau": null, "timestampMs": 1, "height": null, "inputHashes": inputs,
        "recipient": null, "error": null, "changeNau": null, "outputs": []
    }))
    .unwrap()
}

#[test]
fn a_spend_seen_coming_is_written_once_and_holds_its_coins() {
    let mut state = wallet();
    persist(&mut state, &[block(120, vec![coin("a", 1, 120)], &[], &[])]);
    assert!(run(&mut state, |s| record_outgoing(s, outgoing("m1", &["a"]))));
    assert_eq!(state.utxos["a"].pending_txid.as_deref(), Some("m1"));
    assert!(!run(&mut state, |s| record_outgoing(s, outgoing("m1", &["a"]))), "once");

    run(&mut state, |s| expire_row(s, "w:outgoing:a"));
    assert!(!state.history.contains_key("w:outgoing:a"));
    assert_eq!(state.utxos["a"].pending_txid, None, "offered again");
}

#[test]
fn a_spend_seen_coming_does_not_hold_a_coin_the_sync_has_already_marked_spent() {
    let mut state = wallet();
    persist(&mut state, &[block(120, vec![coin("a", 1, 120)], &[], &[])]);
    // The watcher decided on the strength of what it read a moment ago; the
    // sync marked the coin spent before the watcher's write.
    persist(&mut state, &[block(121, vec![], &["a"], &[])]);
    run(&mut state, |s| record_outgoing(s, outgoing("m1", &["a"])));
    assert_eq!(state.utxos["a"].pending_txid, None);
    assert_eq!(state.utxos["a"].spent_height, Some(121));
}

#[test]
fn letting_go_of_an_expired_spend_does_not_release_a_coin_someone_else_now_holds() {
    let mut state = wallet();
    persist(&mut state, &[block(120, vec![coin("a", 1, 120)], &[], &[])]);
    run(&mut state, |s| record_outgoing(s, outgoing("m1", &["a"])));
    // This device's own send took the coin over in the meantime.
    let mut coin_a = state.utxos["a"].clone();
    coin_a.pending_txid = Some("mine".into());
    state.utxos.insert("a".into(), coin_a);
    run(&mut state, |s| expire_row(s, "w:outgoing:a"));
    assert_eq!(state.utxos["a"].pending_txid.as_deref(), Some("mine"));
}

#[test]
fn checking_the_mempool_does_not_undo_a_confirmation_the_sync_wrote_meanwhile() {
    let mut state = wallet();
    persist(&mut state, &[block(120, vec![coin("a", 1, 120)], &[], &[])]);
    run(&mut state, |s| record_pending(s, pending_send("tx1", &["a"], &["out1"])));
    let asked = vec!["w:sent:tx1".to_string()];

    // While the node was being asked, the send was confirmed.
    persist(&mut state, &[block(121, vec![], &["a"], &["out1"])]);
    let present: BTreeSet<String> = ["out1".to_string()].into();
    run(&mut state, |s| mark_mempool_checked(s, &asked, &present, 50));
    let sent = row(&state, "sent:tx1");
    assert_eq!(sent["status"], json!("confirmed"), "the confirmation stands");
    assert!(sent.get("mempoolCheckedAt").is_none());
}

#[test]
fn checking_the_mempool_records_when_a_pending_send_was_last_seen_there() {
    let mut state = wallet();
    persist(&mut state, &[block(120, vec![coin("a", 1, 120), coin("b", 1, 120)], &[], &[])]);
    run(&mut state, |s| record_pending(s, pending_send("tx1", &["a"], &["out1"])));
    run(&mut state, |s| record_pending(s, pending_send("tx2", &["b"], &["out2"])));
    let asked = vec!["w:sent:tx1".to_string(), "w:sent:tx2".to_string()];
    run(&mut state, |s| mark_mempool_checked(s, &asked, &["out1".to_string()].into(), 50));
    assert_eq!((row(&state, "sent:tx1")["mempoolSeenAt"].clone(), row(&state, "sent:tx1")["mempoolCheckedAt"].clone()), (json!(50), json!(50)));
    assert_eq!((row(&state, "sent:tx2")["mempoolSeenAt"].clone(), row(&state, "sent:tx2")["mempoolCheckedAt"].clone()), (Value::Null, json!(50)));
    // Seen once, then missing: the last sighting is kept.
    run(&mut state, |s| mark_mempool_checked(s, &asked, &BTreeSet::new(), 60));
    assert_eq!(row(&state, "sent:tx1")["mempoolSeenAt"], json!(50));
}

#[test]
fn a_payment_on_its_way_in_is_written_once() {
    let mut state = wallet();
    let entry = history_entry(json!({
        "key": "w:incoming:cm-z", "accountId": W, "kind": "received", "status": "pending", "txid": "m",
        "amountNau": "9", "feeNau": null, "timestampMs": 1, "height": null, "inputHashes": [],
        "recipient": null, "error": null, "outputs": [{ "commitment": "cm-z", "role": "recipient" }], "releaseDateMs": null
    }))
    .unwrap();
    assert!(run(&mut state, |s| record_incoming(s, entry.clone())));
    assert!(!run(&mut state, |s| record_incoming(s, entry)));
    run(&mut state, |s| drop_row(s, "w:incoming:cm-z"));
    assert!(state.history.is_empty());
}

#[test]
fn a_wallet_with_no_scan_state_is_refused_rather_than_guessed_at() {
    let state = WalletState::default();
    assert!(start_pass(&state, 10).is_err());
    assert!(persist_scan(&state, W, &[block(1, vec![], &[], &[])], FRESH_KEY_INDICES, KEEP_BLOCKS, 0).is_err());
}
