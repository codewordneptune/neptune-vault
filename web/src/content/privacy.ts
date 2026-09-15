// The privacy statement, shown in the app under About and mirrored in
// docs/PRIVACY.md. Keep the two in step; the app text is the reference.

export interface PrivacySection {
  title: string;
  paragraphs: string[];
}

export const PRIVACY_UPDATED = '2026-09-15';

export const PRIVACY: PrivacySection[] = [
  {
    title: 'What this wallet keeps on your device',
    paragraphs: [
      'Your seed phrase, encrypted with your password (and, if you turn it on, wrapped for your passkey), the addresses and coins found by scanning, your history, your contacts, the settings, and a record of the last proof. All of it lives in this browser\'s storage on this device. Nothing is kept anywhere else by this app.',
      'Clearing the browser\'s site data deletes all of it. The phrase or a backup file is the only way back.',
    ],
  },
  {
    title: 'What leaves your device, and to whom',
    paragraphs: [
      'The node you chose in Settings. The app talks only to that node, over its JSON-RPC interface, and only for five things: fetching blocks to scan, asking which transactions are waiting in the mempool and fetching the ones it has not seen, asking for membership proofs of the coins it is about to spend, submitting a transaction you sent, and, in a fast restore, asking its coin index which blocks hold payments to your addresses and where your coins were spent. The node sees your network address and everything you ask it. From what you ask, it can learn which blocks you scan from (roughly when your wallet was created), which coins you own (the membership-proof request names them), and the transactions you send. A fast restore tells it more: the identifiers of your addresses, and with them every payment you have received and every coin you have spent, though not the amounts. The private restore, which downloads the chain, tells it none of that. It does not receive your phrase, your password, your addresses as such, your contacts, or the notes and names in payment links.',
      'The host serving the app. Opening or updating the app fetches its files from the site it is installed from. Like any web host, it can log the requests it receives, including your network address. It receives nothing about your wallet.',
      'The explorer, if you tap a link to it. An explorer link opens a page about one output on an external site, which then knows that someone looked at that output. You choose whether to tap.',
      'Whoever you share with. A payment link or QR code carries your address, the amount, and any name or note you typed; the share sheet hands it to the app you pick. A sender\'s wallet shows the name as unverified. Nothing in a link reaches the chain.',
    ],
  },
  {
    title: 'What is public on the chain',
    paragraphs: [
      'Every payment to you is announced on the chain with an identifier derived from the address it was sent to, so all payments to one address can be linked by anyone reading the chain, by count and timing. Amounts and senders are not revealed. Your own transactions are public as transactions; the wallet\'s proofs reveal nothing about your keys.',
      'A viewing address, if you hand one out, lets its holder see every payment it receives. The Receive screen says so beside it.',
    ],
  },
  {
    title: 'What this app does not do',
    paragraphs: [
      'No analytics, no telemetry, no crash reporting, no advertising, no cookies for tracking. The Diagnostics screen shows facts about this device to you; it sends them nowhere.',
      'The camera, when you scan a code, is read on the device; no frame leaves it. The clipboard is written only when you tap Copy, and read only when you tap Paste.',
      'Passkeys are created and stored by your device or its platform account, under that platform\'s own policy; the app stores only a wrapped key that is useless without the passkey.',
    ],
  },
  {
    title: 'Your choices',
    paragraphs: [
      'You choose the node, and can run your own. You choose whether to install the app, which keeps its files on the device and reduces what the host sees to update checks. You choose what goes into a payment link. Backup files are yours: encrypted with your password, written where you save them, never uploaded.',
      'This statement describes the app as published under this version. If a later version changes what leaves the device, this page changes with it, and the date below moves.',
    ],
  },
];
