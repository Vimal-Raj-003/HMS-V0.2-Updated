import { redirect } from 'next/navigation';

/**
 * EN-018 §3.2: the device is configured to open `/display`. Anything else on this
 * origin is a mis-typed kiosk URL, so send it to the one screen that exists.
 */
export default function RootPage(): never {
  redirect('/display');
}
