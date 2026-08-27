'use client';

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@vims/ui';
import { useEffect, useState } from 'react';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { Lock } from '@/lib/icons';
import type { CoSignerInput } from '../api/types';

/**
 * The second pharmacist's signature.
 *
 * ── Why this is a sign-in and not a checkbox ────────────────────────────────
 *
 * `phase-04` exit gate 4 and `docs/04 §1`: an NDPS transaction takes two people.
 * The cheap implementation is a checkbox reading "verified by second
 * pharmacist", or a dropdown of colleagues' names — and both of those are
 * controls one person can satisfy alone, standing at the counter with nobody
 * else in the room. `PharmacyCoSignService` refuses exactly that: it verifies
 * the second person's **own password** with Argon2, checks they are a different
 * active user, checks they hold the authority themselves, and then runs the
 * acting user's full policy evaluation with the co-signer attached.
 *
 * So this dialog asks for a username and a password, and it is the second
 * pharmacist who types them. There is no "same as me" shortcut, and the identity
 * field is deliberately empty each time it opens: a pre-filled colleague's
 * username is one keystroke from a signature they did not give.
 *
 * ── Why the failures are indistinguishable ──────────────────────────────────
 *
 * "No such user", "wrong password" and "not authorised" all come back as the
 * same refusal, and this dialog renders it unchanged. A co-sign prompt that told
 * them apart would be a staff-directory oracle sitting on a screen operated in
 * front of a queue.
 *
 * ── Why only a password ─────────────────────────────────────────────────────
 *
 * `docs/06` §6.9 allows a PIN or a TOTP too. Neither has a verifier in
 * `services/api`, which refuses both with `not-implemented` rather than
 * accepting a factor it cannot check — so offering them here would be offering a
 * control that does not exist.
 */
export function CoSignDialog({
  open,
  onOpenChange,
  title,
  purpose,
  actingUserName,
  pending,
  error,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  /** What the second pharmacist is signing for, in their words. */
  readonly purpose: string;
  readonly actingUserName: string;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onConfirm: (coSigner: CoSignerInput) => void;
}): React.JSX.Element {
  const [identifier, setIdentifier] = useState('');
  const [credential, setCredential] = useState('');

  // Cleared on every open and on every close. A password left in a controlled
  // input on a shared counter tablet is a password anybody can submit.
  useEffect(() => {
    setIdentifier('');
    setCredential('');
  }, [open]);

  const ready = identifier.trim().length > 0 && credential.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel="Cancel — no signature is recorded">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {purpose} The second pharmacist signs in here themselves. Two signatures from one person are one
            signature, and the system refuses it — {actingUserName} cannot countersign their own dispense.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!ready || pending) return;
              onConfirm({
                identifier: identifier.trim(),
                credentialKind: 'password',
                credential,
              });
            }}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="cosign-identifier">Second pharmacist&rsquo;s username</Label>
              <Input
                id="cosign-identifier"
                data-testid="cosign-identifier"
                autoComplete="off"
                autoFocus
                value={identifier}
                onChange={(event) => {
                  setIdentifier(event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="cosign-credential">Their password</Label>
              <Input
                id="cosign-credential"
                data-testid="cosign-credential"
                type="password"
                autoComplete="off"
                value={credential}
                onChange={(event) => {
                  setCredential(event.target.value);
                }}
              />
              <p className="text-2xs text-fg-muted">
                Typed by them, not by you. It is verified against their own account and never stored on this
                device.
              </p>
            </div>

            {error === null || error === undefined ? null : <ProblemCard error={error} />}

            <DialogFooter>
              <Button
                type="submit"
                variant="primary"
                data-testid="cosign-confirm"
                disabled={!ready || pending}
              >
                <Lock aria-hidden="true" className="size-4" />
                {pending ? 'Verifying…' : 'Countersign'}
              </Button>
            </DialogFooter>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
