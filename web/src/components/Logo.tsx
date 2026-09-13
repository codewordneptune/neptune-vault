// The Neptune brand mark, the same path data as useneptune.org's Logo.astro
// and favicon. Decorative: the wordmark next to it is the accessible text.

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="53 56 194 194"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ display: 'block', color: 'var(--mantine-color-neptune-5)' }}
    >
      <path
        fill="currentColor"
        d="M98.3,223.9H73.2v-95.9c0-30.6,24.9-55.5,55.5-55.5s55.5,24.9,55.5,55.5v51.7h-25.1v-51.7c0-16.8-13.6-30.4-30.4-30.4s-30.4,13.6-30.4,30.4V223.9z"
      />
      <path
        fill="currentColor"
        d="M171.3,227.5c-30.6,0-55.5-24.9-55.5-55.5v-51.7h25.1v51.7c0,16.8,13.6,30.4,30.4,30.4s30.4-13.6,30.4-30.4V76.1h25.1v95.9C226.8,202.6,201.9,227.5,171.3,227.5z"
      />
    </svg>
  );
}
