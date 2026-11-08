export default function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <rect width="40" height="40" rx="11" fill="#173e35" />
      <path d="m20 7 3.8 8.8 9.5 1-7.1 6.5 2 9.4-8.2-4.9-8.2 4.9 2-9.4-7.1-6.5 9.5-1Z" fill="#dd885c" />
    </svg>
  );
}
