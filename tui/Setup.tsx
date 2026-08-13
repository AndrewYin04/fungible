import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { spawn } from 'node:child_process';
import { seedRules } from '../core/seed-rules.js';
import { readEnvFile, writeEnvFile } from '../core/env-file.js';
import { getSetting, setSetting, daysFromStartDate, DEFAULT_START_DATE_KEY, MAX_DAYS_REQUESTED, START_DATE_BUFFER_DAYS } from '../core/settings.js';
import { C_POSITIVE, C_NEGATIVE, C_WARNING, C_ACCENT } from './ui.js';
import { TextInput } from './components/index.js';

/** process.env has no "unset" value: assigning '' leaves the variable present
 *  and empty, which is not the same thing as a credential the owner removed. */
function setProcessEnv(key: string, value: string): void {
  if (value) process.env[key] = value;
  else delete process.env[key];
}

/** What an empty credential field is about to do when the wizard saves. Blank
 *  means remove, so the owner is told that before they press Enter — and told
 *  the harmless version when there is nothing stored to remove. */
function BlankFieldNote({ emptied, stored, label }: { emptied: boolean; stored?: string; label: string }) {
  if (!emptied) return null;
  return stored
    ? <Text color={C_WARNING}>Empty — your saved Plaid {label} will be removed when you save</Text>
    : <Text dimColor>Empty — leave it blank to skip Plaid for now</Text>;
}

type Step =
  | 'welcome'
  | 'plaid-choice'
  | 'plaid-client-id'
  | 'plaid-secret'
  | 'plaid-env'
  | 'start-date'
  | 'link-choice'
  | 'linking'
  | 'seed-choice'
  | 'done';

type PlaidEnv = 'sandbox' | 'production';
const PLAID_ENVS: PlaidEnv[] = ['sandbox', 'production'];

export function Setup() {
  const { exit } = useApp();
  const existing = readEnvFile();

  const [step, setStep] = useState<Step>('welcome');

  // Plaid credential fields
  const [clientId, setClientId] = useState(existing['PLAID_CLIENT_ID'] ?? '');
  const [secret, setSecret] = useState(existing['PLAID_SECRET'] ?? '');
  const [plaidEnvIdx, setPlaidEnvIdx] = useState<number>(
    Math.max(0, PLAID_ENVS.indexOf((existing['PLAID_ENV'] as PlaidEnv) ?? 'sandbox'))
  );

  // Default history start date (persisted in DB settings)
  const [startDateInput, setStartDateInput] = useState('');
  const [startDateError, setStartDateError] = useState('');
  useEffect(() => {
    void getSetting(DEFAULT_START_DATE_KEY).then((v) => {
      if (v) setStartDateInput(v);
    });
  }, []);

  // Link flow
  const [linkStatus, setLinkStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [linkMsg, setLinkMsg] = useState('');

  // Seed status
  const [seedResult, setSeedResult] = useState<{ rules: number; recategorized: number } | null>(null);

  const alreadyConfigured =
    !!existing['PLAID_CLIENT_ID'] && !!existing['PLAID_SECRET'] && !!existing['PLAID_ENV'];

  function savePlaidCreds() {
    // writeEnvFile is the single writer: it creates the file 0600, chmods a
    // pre-existing one, preserves unrelated keys/comments, and rejects values
    // containing line breaks (which would otherwise inject extra env entries).
    //
    // A field the owner emptied is passed as an empty string, which is how
    // writeEnvFile is told to remove that key. It used to ignore empty values,
    // so clearing a credential here moved the wizard on while the old secret
    // stayed on disk.
    const clientIdValue = clientId.trim();
    const secretValue = secret.trim();
    writeEnvFile({
      PLAID_CLIENT_ID: clientIdValue,
      PLAID_SECRET: secretValue,
      PLAID_ENV: PLAID_ENVS[plaidEnvIdx],
    });
    // Reload env for the current process. A credential that was removed has to
    // go from here too, or this process keeps using it until it restarts.
    setProcessEnv('PLAID_CLIENT_ID', clientIdValue);
    setProcessEnv('PLAID_SECRET', secretValue);
    setProcessEnv('PLAID_ENV', PLAID_ENVS[plaidEnvIdx]);
  }

  function startLink() {
    setLinkStatus('running');
    setLinkMsg('Opening browser…');
    const node = process.execPath;
    const script = new URL('../scripts/link.ts', import.meta.url).pathname;
    const child = spawn(node, [
      '--no-warnings',
      '--import', 'tsx/esm',
      script,
    ], { cwd: new URL('..', import.meta.url).pathname });
    child.stdout.on('data', (data: Buffer) => {
      const line = data.toString().trim().split('\n').pop() ?? '';
      if (line) setLinkMsg(line);
    });
    child.stderr.on('data', (data: Buffer) => {
      setLinkStatus('error');
      setLinkMsg(data.toString().trim());
    });
    child.on('close', (code: number) => {
      if (code === 0) {
        setLinkStatus('done');
        setLinkMsg('Bank linked successfully.');
      } else if (code !== null) {
        setLinkStatus('error');
        setLinkMsg(`Process exited with code ${code}.`);
      }
    });
  }

  function validateStartDate(raw: string): string | null {
    const value = raw.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Enter a date as YYYY-MM-DD';
    const d = new Date(value + 'T12:00:00');
    if (isNaN(d.getTime()) || value !== d.toISOString().slice(0, 10)) return 'Not a valid calendar date';
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    if (d.getTime() > today.getTime()) return 'Start date cannot be in the future';
    return null;
  }

  async function saveStartDate() {
    const value = startDateInput.trim();
    try {
      await setSetting(DEFAULT_START_DATE_KEY, value);
      setStep('link-choice');
    } catch {
      setStartDateError('Failed to save — please try again');
    }
  }

  useInput((input, key) => {
    if (step === 'welcome') {
      if (key.return) {
        setStep(alreadyConfigured ? 'start-date' : 'plaid-choice');
      }
      return;
    }

    if (step === 'plaid-choice') {
      if (input === 'y') { setStep('plaid-client-id'); return; }
      if (input === 'n') { setStep('seed-choice'); return; }
      return;
    }

    if (step === 'plaid-client-id') {
      if (key.escape) { setStep('plaid-choice'); return; }
      // An empty field is allowed through: it is how the owner says "remove the
      // one I have". Refusing to move on left them stuck on a field they had
      // deliberately cleared, with Enter falling through to the printable-input
      // branch below and typing a carriage return into the value.
      if (key.return) { setStep('plaid-secret'); return; }
      if (key.backspace || key.delete) { setClientId((v) => v.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setClientId((v) => v + input); return; }
      return;
    }

    if (step === 'plaid-secret') {
      if (key.escape) { setStep('plaid-client-id'); return; }
      if (key.return) { setStep('plaid-env'); return; }
      if (key.backspace || key.delete) { setSecret((v) => v.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setSecret((v) => v + input); return; }
      return;
    }

    if (step === 'plaid-env') {
      if (key.escape) { setStep('plaid-secret'); return; }
      if (key.leftArrow)  { setPlaidEnvIdx((i) => (i - 1 + PLAID_ENVS.length) % PLAID_ENVS.length); return; }
      if (key.rightArrow) { setPlaidEnvIdx((i) => (i + 1) % PLAID_ENVS.length); return; }
      if (key.return) { savePlaidCreds(); setStep('start-date'); return; }
      return;
    }

    if (step === 'start-date') {
      if (key.escape) { setStep(alreadyConfigured ? 'welcome' : 'plaid-env'); setStartDateError(''); return; }
      if (key.return) {
        if (!startDateInput.trim()) { setStep('link-choice'); return; }
        const err = validateStartDate(startDateInput);
        if (err) { setStartDateError(err); return; }
        setStartDateError('');
        void saveStartDate();
        return;
      }
      if (key.backspace || key.delete) { setStartDateInput((v) => v.slice(0, -1)); setStartDateError(''); return; }
      if (input && /^[0-9-]+$/.test(input) && !key.ctrl && !key.meta && startDateInput.length < 10) {
        setStartDateInput((v) => v + input); setStartDateError(''); return;
      }
      return;
    }

    if (step === 'link-choice') {
      if (input === 'y') { setStep('linking'); startLink(); return; }
      if (input === 'n') { setStep('seed-choice'); return; }
      return;
    }

    if (step === 'linking') {
      if ((linkStatus === 'done' || linkStatus === 'error') && key.return) {
        setStep('seed-choice');
      }
      return;
    }

    if (step === 'seed-choice') {
      if (input === 'y') {
        void seedRules().then((result) => { setSeedResult(result); setStep('done'); });
        return;
      }
      if (input === 'n') { setStep('done'); return; }
      return;
    }

    if (step === 'done') {
      if (key.return) exit();
      return;
    }
  });

  const startDateIsValid = step === 'start-date' && validateStartDate(startDateInput) === null;
  const startDateRequestedDays = startDateIsValid ? daysFromStartDate(startDateInput.trim()) : null;
  const startDateCapped = startDateRequestedDays === MAX_DAYS_REQUESTED;

  return (
    <Box flexDirection="column" paddingX={3} paddingY={2}>
      <Box marginBottom={1}>
        <Text bold color={C_ACCENT}>fungible  </Text>
        <Text dimColor>setup</Text>
      </Box>

      {step === 'welcome' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>Welcome to fungible</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>This wizard will help you:</Text>
            <Text dimColor>  · Configure Plaid credentials (to sync bank accounts)</Text>
            <Text dimColor>  · Choose how far back to pull transactions</Text>
            <Text dimColor>  · Link your first bank account</Text>
            <Text dimColor>  · Seed starter category rules</Text>
          </Box>
          {alreadyConfigured && (
            <Box marginTop={1}>
              <Text color={C_POSITIVE}>Plaid credentials already configured in .env</Text>
            </Box>
          )}
          <Box marginTop={1}><Text dimColor>Press Enter to begin</Text></Box>
        </Box>
      )}

      {step === 'plaid-choice' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>Plaid credentials</Text>
          <Text dimColor>
            Plaid lets fungible sync transactions directly from your bank.
            You need a free Plaid developer account at plaid.com.
          </Text>
          <Box marginTop={1}>
            <Text>Do you have a Plaid account?  </Text>
            <Text color={C_ACCENT}>[y] Yes  </Text>
            <Text color={C_ACCENT}>[n] Skip</Text>
          </Box>
        </Box>
      )}

      {step === 'plaid-client-id' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>Plaid Client ID</Text>
          <Text dimColor>Found in your Plaid dashboard under Team Settings → Keys</Text>
          <Box marginTop={1}>
            <Text>Client ID: </Text>
            {/* Masked like the secret below: every rendered frame is mirrored to
                DATA_DIR/screen.txt and served by the get_screen MCP tool, so a
                credential shown in the clear here is readable from there. */}
            <TextInput value={'*'.repeat(clientId.length)} color={C_WARNING} />
          </Box>
          <BlankFieldNote emptied={clientId.trim() === ''} stored={existing['PLAID_CLIENT_ID']} label="Client ID" />
          <Text dimColor>Enter to continue · Esc back</Text>
        </Box>
      )}

      {step === 'plaid-secret' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>Plaid Secret</Text>
          <Text dimColor>The secret key for your chosen environment</Text>
          <Box marginTop={1}>
            <Text>Secret: </Text>
            <TextInput value={'*'.repeat(secret.length)} color={C_WARNING} />
          </Box>
          <BlankFieldNote emptied={secret.trim() === ''} stored={existing['PLAID_SECRET']} label="Secret" />
          <Text dimColor>Enter to continue · Esc back</Text>
        </Box>
      )}

      {step === 'plaid-env' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>Plaid Environment</Text>
          <Text dimColor>Use "sandbox" for testing, "production" for real bank data</Text>
          <Box marginTop={1} gap={2}>
            <Text>Environment: </Text>
            <Text dimColor>← </Text>
            <Text color={C_ACCENT}>{PLAID_ENVS[plaidEnvIdx]}</Text>
            <Text dimColor> →</Text>
          </Box>
          <Text dimColor>← → to change · Enter to save</Text>
        </Box>
      )}

      {step === 'start-date' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>Default history start date</Text>
          <Text dimColor>
            How far back should fungible pull transactions when you link a bank?
            We&apos;ll use this to pre-fill the number of days requested, so you don&apos;t
            have to do the math.
          </Text>
          <Text dimColor>
            Plaid doesn&apos;t document the timezone it uses for the history window, so we add a
            {' '}{START_DATE_BUFFER_DAYS}-day buffer to make sure your start date isn&apos;t missed.
          </Text>
          <Box marginTop={1}>
            <Text>Start date (YYYY-MM-DD): </Text>
            <TextInput value={startDateInput} color={C_WARNING} />
          </Box>
          {startDateRequestedDays != null && (
            <Text dimColor>= {startDateRequestedDays} days of history requested (incl. {START_DATE_BUFFER_DAYS}-day buffer)</Text>
          )}
          {startDateCapped && (
            <Text color={C_WARNING}>Plaid limits history to {MAX_DAYS_REQUESTED} days, so it&apos;ll be capped there.</Text>
          )}
          {startDateError && <Text color={C_NEGATIVE}>{startDateError}</Text>}
          <Text dimColor>Enter to save · Leave blank to skip · Esc back</Text>
        </Box>
      )}

      {step === 'link-choice' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>Link a bank account</Text>
          <Text dimColor>Connect your first bank via Plaid (opens in browser)</Text>
          <Box marginTop={1}>
            <Text>Link now?  </Text>
            <Text color={C_ACCENT}>[y] Yes  </Text>
            <Text color={C_ACCENT}>[n] Skip</Text>
          </Box>
        </Box>
      )}

      {step === 'linking' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>Linking bank account</Text>
          <Text color={linkStatus === 'done' ? C_POSITIVE : linkStatus === 'error' ? C_NEGATIVE : C_WARNING}>
            {linkMsg}
          </Text>
          {linkStatus === 'running' && (
            <Text dimColor>Complete the Plaid flow in your browser, then return here.</Text>
          )}
          {(linkStatus === 'done' || linkStatus === 'error') && (
            <Text dimColor>Press Enter to continue.</Text>
          )}
        </Box>
      )}

      {step === 'seed-choice' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>Category rules</Text>
          <Text dimColor>Seed a set of starter rules to auto-categorize common transactions.</Text>
          <Text dimColor>You can edit or delete these anytime from the Rules screen.</Text>
          <Box marginTop={1}>
            <Text>Seed rules?  </Text>
            <Text color={C_ACCENT}>[y] Yes  </Text>
            <Text color={C_ACCENT}>[n] Skip</Text>
          </Box>
        </Box>
      )}

      {step === 'done' && (
        <Box flexDirection="column" gap={1}>
          <Text bold color={C_POSITIVE}>Setup complete</Text>
          {seedResult && (
            <Text dimColor>{seedResult.rules} rules seeded · {seedResult.recategorized} transactions recategorized</Text>
          )}
          <Box marginTop={1} flexDirection="column">
            <Text>Run <Text color={C_ACCENT}>fungible</Text> to launch.</Text>
          </Box>
          <Box marginTop={1}><Text dimColor>Press Enter to exit</Text></Box>
        </Box>
      )}
    </Box>
  );
}
