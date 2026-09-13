// Canonical themed SVGs are copied to /icons by task brand:generate and the
// extension build. Keep artwork out of this component so it cannot drift.

export function RemixletLogo({ className }: { className?: string }) {
  return (
    <span className={`inline-block shrink-0 ${className ?? ""}`} aria-hidden="true">
      <img
        src="/icons/remixlet-icon-light.svg"
        className="block size-full dark:hidden"
        width={512}
        height={512}
        alt=""
      />
      <img
        src="/icons/remixlet-icon-dark.svg"
        className="hidden size-full dark:block"
        width={512}
        height={512}
        alt=""
      />
    </span>
  );
}
