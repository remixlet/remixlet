// The marketing site's backdrop: an emerald glow at the top left fading to
// the canvas — fixed so it stays viewport-anchored, exactly like the
// website's body::before. Dark is the site's gradient verbatim; light is the
// same shape in the light scheme's tints. Render it inside a
// `relative isolate` container so -z-10 stays behind that surface only.
export function GradientBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(110%_90%_at_32%_18%,#dcebe2_0%,#e9eee6_48%,#f4f3ee_92%)] dark:bg-[radial-gradient(110%_90%_at_32%_18%,#164237_0%,#123129_48%,#131315_92%)]"
    />
  );
}
