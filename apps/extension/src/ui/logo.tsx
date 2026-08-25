// The Remixlet mark, inlined from the website's public/logo.svg (the same
// file the toolbar icons in assets/icons are rasterized from) so extension
// surfaces can draw it without a copied asset or a runtime URL.

export function RemixletLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true" focusable="false">
      <rect width="16" height="16" rx="4" fill="#164237" />
      <path
        d="M4.44 11.39V4.61h4.75a2.15 2.15 0 0 1 .68 4.18L12.92 11.39H10.77L8.06 9.02H6.25V11.39Z"
        fill="#3EC98F"
      />
    </svg>
  );
}
