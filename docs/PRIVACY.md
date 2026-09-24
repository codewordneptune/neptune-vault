# Privacy

What this wallet keeps, what it sends and to whom, and what is public. The
same text is shown in the app under Settings, About, Privacy; the app's copy
(`web/src/content/privacy.ts`) is the reference and this file mirrors it.
Last changed 2026-09-24.

The desktop app shows the same statement with a few sentences changed where
it differs from a browser; those are marked *In the desktop app* below.

## What this wallet keeps on your device

Your seed phrase, encrypted with your password (and, if you turn it on,
wrapped for your passkey), the addresses and coins found by scanning, your
history, your contacts, the settings, and a record of the last proof. All of
it lives in this browser's storage on this device. Nothing is kept anywhere
else by this app.

Clearing the browser's site data deletes all of it. The seed phrase or a backup
file is the only way back.

*In the desktop app:* all of it lives in the app's own storage on this
device, and deleting the app's data deletes all of it.

## What leaves your device, and to whom

**The node you chose in Settings.** The app talks only to that node, over its
JSON-RPC interface, and only for five things: fetching blocks to scan, asking
which transactions are waiting in the mempool and fetching the ones it has
not seen, asking for membership proofs of the coins it is about to spend,
submitting a transaction you sent, and, in a fast restore, asking its coin
index which blocks hold payments to your addresses and where your coins were
spent. The node sees your network address and everything you ask it. From
what you ask, it can learn which blocks you scan from (roughly when your
wallet was created), which coins you own (the membership-proof request names
them), and the transactions you send. A fast restore tells it more: the
identifiers of your addresses, and with them every payment you have received
and every coin you have spent, though not the amounts. The private restore,
which downloads the chain, tells it none of that. It does not receive your
seed phrase, your password, your addresses as such, your contacts, or the notes
and names in payment links.

**The host serving the app.** Opening or updating the app fetches its files
from the site it is installed from. Like any web host, it can log the
requests it receives, including your network address. It receives nothing
about your wallet.

*In the desktop app*, instead: **GitHub.** The app carries its own files,
and every few hours asks GitHub whether a newer version of it has been
published. Like any web host, GitHub can log that request, including your
network address. It receives nothing about your wallet.

**The explorer, if you tap a link to it.** An explorer link opens a page
about one output on an external site, which then knows that someone looked
at that output. You choose whether to tap.

**Price sites, only if you turn on "Value in another currency" in Settings.**
While it is on and the app is open, the app asks CoinGecko, or CoinPaprika
when CoinGecko does not answer, for the price of NPT in the currency you
chose, every 10 minutes. They see your network address and that this is a
Neptune Cash wallet. They receive nothing about your wallet: no address, no
balance. With the setting off, the app never contacts them.

**Whoever you share with.** A payment link or QR code carries your address,
the amount, and any name or note you typed; the share sheet hands it to the
app you pick. A sender's wallet shows the name as unverified. Nothing in a
link reaches the chain.

## What the node is trusted for

This wallet keeps no copy of the chain, so what it shows comes from the node. It checks what it cheaply can: that the blocks are the ones it asked for, that each follows the last one it scanned, that each was really mined at a difficulty the network has had, that a payment it shows is announced to your key and carried by that block, and that the node runs the network your wallet is on. A node therefore cannot simply invent a payment; it would have to mine one.

What it cannot check: the proof inside a block, and whether the node shows the heaviest chain or all of it. A dishonest node can hide payments or spends from you, show you a stale chain, and see which blocks you ask for. It can never spend your coins or learn your keys. For amounts that matter, wait for several blocks, and use a node you trust or run your own.

## What is public on the chain

Every payment to you is announced on the chain with an identifier derived
from the address it was sent to, so all payments to one address can be
linked by anyone reading the chain, by count and timing. Amounts and senders
are not revealed. Your own transactions are public as transactions; the
wallet's proofs reveal nothing about your keys.

A viewing address, if you hand one out, lets its holder see every payment it
receives. The Receive screen says so beside it.

## What this app does not do

No analytics, no telemetry, no crash reporting, no advertising, no cookies
for tracking. The Diagnostics screen shows facts about this device to you;
it sends them nowhere.

The camera, when you scan a code, is read on the device; no frame leaves it.
The clipboard is written only when you tap Copy. The app never reads it by
itself: it sees only what you paste, into a field or, as an image, into the
scanner, and the site tells the browser to refuse it clipboard reads
altogether. (*In the desktop app*, without that last clause: the rule is a
header the site sends, which the desktop app does not load.)

Passkeys are created and stored by your device or its platform account,
under that platform's own policy; the app stores only a wrapped key that is
useless without the passkey.

## Your choices

You choose the node, and can run your own. You choose whether to install the
app, which keeps its files on the device and reduces what the host sees to
update checks (*not in the desktop app*, which is installed already). You choose what goes into a payment link. Backup files are
yours: encrypted with your password, written where you save them, never
uploaded.

This statement describes the app as published under this version. If a
later version changes what leaves the device, this page changes with it, and
the date above moves.
