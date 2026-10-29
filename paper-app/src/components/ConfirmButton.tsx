interface Props {
  armed: boolean;
  onClick: () => void;
  label: string;
  confirmLabel: string;
  disabled?: boolean;
}

/** A small button that asks for a second click ("Confirm ...") before doing anything destructive. */
export function ConfirmButton({ armed, onClick, label, confirmLabel, disabled }: Props) {
  return (
    <button type="button" className={`pt-small${armed ? ' pt-armed' : ''}`} onClick={onClick} disabled={disabled}>
      {armed ? confirmLabel : label}
    </button>
  );
}
