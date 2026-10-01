import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-muted-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        // domain verdicts — JEV evidence, not authorization
        ok: 'border-transparent text-[--color-ok] bg-[color-mix(in_srgb,var(--ok)_12%,transparent)]',
        warn: 'border-transparent text-[--color-warn] bg-[color-mix(in_srgb,var(--warn)_12%,transparent)]',
        danger: 'border-transparent text-[--color-danger] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]',
        agent: 'border-transparent bg-[--violet-soft] text-[#c4b5fd]',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): React.ReactElement {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
