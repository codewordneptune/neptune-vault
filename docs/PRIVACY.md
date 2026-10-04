# Privacy statement

What this wallet keeps, what it sends and to whom, and what is public. The
same text is shown in the app under Settings, About, Privacy statement; the
app's copy (`web/src/content/privacy.ts`) is the reference and this file
mirrors it. Last changed 2026-10-03.

The desktop and Android apps show the same statement with a few sentences
changed where they differ from a browser; those are marked below.

In short: your seed phrase and keys never leave this device. The node you
use sees your sends and which pending payments are yours, and a fast
restore tells it every payment you have received. Other sites learn nothing
about your wallet, unless you tap an explorer link to one of your coins.
What anyone can read on the chain is near the end.

## What this wallet keeps on your device

Your seed phrase, encrypted with your password (and, if you turn it on,
wrapped for your passkey). The coins found by scanning, your history and
its notes, your contacts, the names you gave your addresses and which of
them you have given out, all encrypted too, so they cannot be read while
the wallet is locked. Your seed phrase can open all of it too, so that it
can set a new password if you forget yours. Kept without encryption: each
wallet's name, network, creation time, start block and address count, and
the settings, such as the node's address, the lock times and a record of
the last proof. All of it lives in this browser's storage on this device.
Nothing is kept anywhere else by this app.

*In the desktop and Android apps:* all of it lives in the app's own storage
on this device.

While you set up a new wallet, its new seed phrase is kept without
encryption, so a reload does not lose it, until the wallet is made, you
leave setup or the tab closes (*in the desktop and Android apps*, the app
closes). An imported seed phrase is never kept that way.

Clearing the browser's site data deletes all of it. The seed phrase or a
backup file is the only way back.

*In the desktop and Android apps:* deleting the app's data deletes all of
it.

## What leaves your device, and to whom

**The node set in Settings.** Unless you chose another, this is the app's
default node, wallet.neptunefundamentals.org. It sees your network address
and every question the app asks it, over its JSON-RPC interface. While the
wallet is unlocked and on screen, the app asks it about every 15 seconds
for its newest block and the new blocks to scan here, fetches the
transactions waiting in its mempool to scan them here too, and asks whether
it still holds the outputs of your pending payments, in and out. It asks
for the block of a date, or the date of a block, when a restore or rescan
starts from a month, when a wallet was made while the node could not be
reached, and to say when your history starts. When you send, it asks for
the proofs of the coins the send spends, then hands it the send itself.

From this the node can learn roughly when your wallet started (the blocks
you scan from), which pending payments are yours (the outputs it is asked
about), which coins each send spends, and the sends you make. If you keep
several wallets here and use one node, it can tell they are on the same
device. It never receives your seed phrase, your password, your contacts,
the names you gave your addresses, or the names and notes in payment
requests. Your addresses reach it only as identifiers, in a fast restore or
a rebuild (below).

**A fast restore or rescan tells it more.** The identifiers of all your
addresses, including a few of each kind you have not used yet, go to its
coin index. The node then learns every payment you have received and every
coin you have spent, and can recognise later payments to those addresses
too, though not the amounts. The app does the same, if the node has a coin
index, when it rebuilds a wallet's history from the chain: after you tap
Rebuild from the chain, or when an update could not carry the history
over. The private restore and rescan, which download the blocks, tell it
none of that.

**The host serving the app.** The official site is
vault.dev.useneptune.org, hosted on Microsoft Azure. The first visit loads
the app's files from it, and the browser keeps them. After that the app
asks the site whether a newer version is published: when you open it,
about every hour while it is open, and each time you come back to it. Like
any web host, the site can log those requests, including your network
address. It receives nothing about your wallet.

*In the desktop app*, instead: **GitHub.** The desktop app carries its own
files. When it starts, and every six hours while it runs, it asks GitHub
whether a newer version has been published. Like any web host, GitHub can
log those requests, including your network address. It receives nothing
about your wallet.

*In the Android app*, instead: **Updates.** The Android app carries its own
files and never asks anyone whether a newer version is out. A new version
comes only when you install one.

**The explorer, if you tap a link to it.** On Mainnet, a payment's details
in History link each coin to a page about it on neptunefundamentals.org,
which then knows that someone looked at that coin. You choose whether to
tap.

**Price sites, only if you turn on "Value in another currency" in
Settings.** While it is on, and Home, Send or Receive is on screen, the app
asks CoinGecko, or CoinPaprika when CoinGecko does not answer, for the
price of NPT in the currency you chose, at most every 10 minutes. They see
your network address and that this is a Neptune Cash wallet. They receive
nothing about your wallet: no address, no balance. With the setting off,
the app never contacts them.

**Other links, only when you tap them.** Help, the websites under About,
and GitHub (to report a problem, or to see what a new version changes) open
in your browser. Those sites see your network address, but not the page
you came from.

**Whoever you share with.** A payment request or its QR code carries your
address, the amount, and any name or note you typed; the share sheet hands
it to the app you pick. This app shows such a name to the person paying as
unverified, since anyone can type any name. Nothing in a request reaches
the chain.

## What the node is trusted for

This wallet keeps no copy of the chain, so what it shows comes from the
node. It checks what it cheaply can: that the blocks are the ones it asked
for, that each follows the last one it scanned, that on Mainnet each
carries real proof of work, that a payment it shows is announced to your
key and carried by that block, and that the node runs the network your
wallet is on. So on Mainnet a node cannot simply invent a payment; it would
have to mine a block for it. On the test networks it could.

What it cannot check: the proof inside a block, and whether the node shows
the heaviest chain or all of it. A dishonest node can hide payments or
spends from you, show you a stale chain, and see which blocks you ask for.
It can never spend your coins or learn your keys. For amounts that matter,
wait until History shows several blocks since the payment confirmed
(blocks come about every ten minutes), and use a node you trust or run your
own.

## What is public on the chain

Every payment to you is announced on the chain with an identifier derived
from the address it was sent to, so all payments to one address can be
linked by anyone reading the chain, by count and timing. Amounts and
senders are not revealed. Your own transactions are public as transactions;
the wallet's proofs reveal nothing about your keys.

The change from each of your sends comes back to your Standard main
address and is announced the same way, so anyone reading the chain can link
your sends to each other and to payments made to that address, though not
see the amounts. Each transaction's fee and time are public too. To keep a
payer apart from your sends, give them a new address rather than the main
one.

A View-only address, if you hand one out, lets its holder see every payment
it receives. The Receive screen says so beside it.

A Short address, if a future quantum computer learns it, would let its
owner see every payment made to it, though never spend them. The Receive
screen says so too.

## What this app does not do

No analytics, no telemetry, no crash reporting, no advertising, no cookies
for tracking. The Diagnostics and Report a problem pages show facts about
this device to you; they send them nowhere, and copy them only when you
ask.

The camera, when you scan a code, is read on the device; no frame leaves
it. The clipboard is written only when you copy something, and other apps
can read it, so clear it after copying your seed phrase. The app never
reads the clipboard by itself: it sees only what you paste, into a field
or, as an image, into the scanner, and the site tells the browser to refuse
it clipboard reads altogether. (*In the desktop and Android apps*, without
that last clause: the rule is a header the site sends, which the apps do
not load.)

Passkeys are made and kept by your device or its platform account, under
that platform's own rules, and the platform may sync them; yours is listed
there as Neptune Vault. The app keeps only the passkey's id and a key that
is useless without it. Removing a wallet does not delete its passkey:
delete it in your device's password settings.

## Your choices

You choose the node, and can run your own. You choose how to restore or
rescan: Fast, which is preselected, tells the node which payments are
yours; Private downloads the blocks and tells it nothing about your coins.
You choose what goes into a payment request. Backup files are yours:
written where you save them and never uploaded, with the seed phrase,
contacts, address names and who each send paid in them encrypted with your
password.

This statement describes the app as published under this version. If a
later version changes what leaves the device, this page changes with it,
and the date above moves.
