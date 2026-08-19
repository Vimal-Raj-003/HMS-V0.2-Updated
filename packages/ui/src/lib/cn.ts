import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind-aware class merge. The only way class names are combined in this package. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
