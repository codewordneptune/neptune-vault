// A seed phrase, typed or pasted: setup's restore and the lock screen's
// Forgot the password? both take it here. A word is finished once something
// follows it. The finished ones are checked against the word list as they
// come, filled out to a whole phrase with a word that is on it, so the check
// says only which word is not a word; whether the words make a phrase waits
// for whoever takes them.

import { Textarea } from '@mantine/core';
import { useEffect } from 'react';

/** The words of what was typed, lower case. */
export function phraseWords(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function PhraseField({
  text,
  onText,
  error,
  onError,
  checkPhrase,
  autoFocus,
}: {
  text: string;
  onText: (text: string) => void;
  error: string | null;
  onError: (problem: string | null) => void;
  /** Why the words cannot be a phrase, or null. */
  checkPhrase: (words: string[]) => Promise<string | null>;
  /** Focused when the dialog it is in opens. */
  autoFocus?: boolean;
}) {
  const words = phraseWords(text);
  useEffect(() => {
    const finished = /\s$/.test(text) ? words : words.slice(0, -1);
    if (finished.length === 0 || finished.length > 18) return;
    const t = setTimeout(() => {
      const padded = [...finished, ...Array<string>(18 - finished.length).fill('abandon')];
      void checkPhrase(padded).then(
        (problem) => onError(problem && problem.startsWith('Word ') ? problem : null),
        () => undefined,
      );
    }, 400);
    return () => clearTimeout(t);
    // The words are read from the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <Textarea
      label="Seed phrase (18 words)"
      description={words.length === 0 ? undefined : words.length > 18 ? '18 words needed, you have ' + words.length : words.length + ' of 18 words'}
      autoCapitalize="none"
      autoCorrect="off"
      autoComplete="off"
      spellCheck={false}
      autosize
      minRows={3}
      value={text}
      error={error ?? undefined}
      data-autofocus={autoFocus || undefined}
      onChange={(e) => {
        onText(e.currentTarget.value);
        onError(null);
      }}
    />
  );
}
