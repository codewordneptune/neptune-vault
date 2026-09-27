// The privacy statement, shown in the app under About and mirrored in
// docs/PRIVACY.md. Keep the two in step; the app text is the reference.
// The desktop app keeps its data and gets its files differently: the few
// sentences about that follow where it runs.

import { NATIVE } from '../app/platform';

export interface PrivacySection {
  title: string;
  paragraphs: string[];
}

export const PRIVACY_UPDATED = '2026-09-27';

export const PRIVACY: PrivacySection[] = [
  {
    title: 'What this wallet keeps on your device',
    paragraphs: [
      'Your seed phrase, encrypted with your password (and, if you turn it on, wrapped for your passkey), the addresses and coins found by scanning, your history, your contacts, the names you gave your addresses, the settings, and a record of the last proof. All of it lives in ' + (NATIVE ? "the app's own storage" : "this browser's storage") + ' on this device. Nothing is kept anywhere else by this app.',
      NATIVE
        ? "Deleting the app's data deletes all of it. The seed phrase or a backup file is the only way back."
        : "Clearing the browser's site data deletes all of it. The seed phrase or a backup file is the only way back.",
    ],
  },
  {
    title: 'What leaves your device, and to whom',
    paragraphs: [
      "The node set in Settings: the app's default node, unless you chose another. The app talks to it over its JSON-RPC interface and asks it: which network it runs and which block is its newest; the blocks to scan, and whether the blocks already scanned are still part of the chain; the block of a date, when a restore or rescan starts from a month, or when a wallet was made while the node could not be reached; the transactions waiting in its mempool, fetching each one it has not seen; about every 15 seconds while the wallet is open, whether it still holds the outputs of your pending payments, in and out; the membership proofs of the coins a send is about to spend; and, when you send, the send itself. The node sees your network address and every question. From them it can learn roughly when your wallet was created (the blocks you scan from), which waiting payments are yours (the outputs it is asked about), which coins you own (the membership proofs name them), and the sends you make. It does not receive your seed phrase, your password, your addresses as such, your contacts, the names you gave your addresses, or the notes and names in payment requests.",
      "A fast restore or fast rescan tells it more: the identifiers of your addresses, and of the next five of each kind, go to its coin index. The node then learns every payment you have received and every coin you have spent, and can recognise later payments to those addresses too, though not the amounts. The private restore and rescan, which download the chain, tell it none of that.",
      NATIVE
        ? 'GitHub. The app carries its own files, and every few hours asks GitHub whether a newer version of it has been published. Like any web host, GitHub can log that request, including your network address. It receives nothing about your wallet.'
        : 'The host serving the app. Opening the app fetches its files from the site it is installed from, and about every hour the app asks that site whether a newer version is published. Like any web host, it can log those requests, including your network address. It receives nothing about your wallet.',
      'The explorer, if you tap a link to it. An explorer link opens a page about one coin on an external site, which then knows that someone looked at that coin. You choose whether to tap.',
      'Price sites, only if you turn on "Value in another currency" in Settings. While it is on and the app is open, the app asks CoinGecko, or CoinPaprika when CoinGecko does not answer, for the price of NPT in the currency you chose, every 10 minutes. They see your network address and that this is a Neptune Cash wallet. They receive nothing about your wallet: no address, no balance. With the setting off, the app never contacts them.',
      'Whoever you share with. A payment request or its QR code carries your address, the amount, and any name or note you typed; the share sheet hands it to the app you pick. A sender\'s wallet shows the name as unverified. Nothing in a link reaches the chain.',
    ],
  },
  {
    title: 'What the node is trusted for',
    paragraphs: [
      "This wallet keeps no copy of the chain, so what it shows comes from the node. It checks what it cheaply can: that the blocks are the ones it asked for, that each follows the last one it scanned, that each was really mined at a difficulty the network has had, that a payment it shows is announced to your key and carried by that block, and that the node runs the network your wallet is on. A node therefore cannot simply invent a payment; it would have to mine one.",
      "What it cannot check: the proof inside a block, and whether the node shows the heaviest chain or all of it. A dishonest node can hide payments or spends from you, show you a stale chain, and see which blocks you ask for. It can never spend your coins or learn your keys. For amounts that matter, wait until History shows several blocks since the payment confirmed (blocks come about every ten minutes), and use a node you trust or run your own.",
    ],
  },
  {
    title: 'What is public on the chain',
    paragraphs: [
      'Every payment to you is announced on the chain with an identifier derived from the address it was sent to, so all payments to one address can be linked by anyone reading the chain, by count and timing. Amounts and senders are not revealed. Your own transactions are public as transactions; the wallet\'s proofs reveal nothing about your keys.',
      'A View-only address, if you hand one out, lets its holder see every payment it receives. The Receive screen says so beside it.',
    ],
  },
  {
    title: 'What this app does not do',
    paragraphs: [
      'No analytics, no telemetry, no crash reporting, no advertising, no cookies for tracking. The Diagnostics screen shows facts about this device to you; it sends them nowhere.',
      NATIVE
        ? 'The camera, when you scan a code, is read on the device; no frame leaves it. The clipboard is written only when you tap Copy. The app never reads it by itself: it sees only what you paste, into a field or, as an image, into the scanner.'
        : 'The camera, when you scan a code, is read on the device; no frame leaves it. The clipboard is written only when you tap Copy. The app never reads it by itself: it sees only what you paste, into a field or, as an image, into the scanner, and the site tells the browser to refuse it clipboard reads altogether.',
      'Passkeys are created and stored by your device or its platform account, under that platform\'s own policy; the app stores only a wrapped key that is useless without the passkey.',
    ],
  },
  {
    title: 'Your choices',
    paragraphs: [
      'You choose the node, and can run your own.' + (NATIVE ? '' : ' You choose whether to install the app, which keeps its files on the device and reduces what the host sees to update checks.') + ' You choose what goes into a payment request. Backup files are yours: encrypted with your password, written where you save them, never uploaded.',
      'This statement describes the app as published under this version. If a later version changes what leaves the device, this page changes with it, and the date above moves.',
    ],
  },
];
