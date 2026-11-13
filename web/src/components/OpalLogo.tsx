import type { SVGProps } from "react";

/**
 * The Opal mark: four rounded color arcs forming an O on a warm paper tile.
 * Colors echo the four opal facets while staying close to the Square palette.
 */
export function OpalLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="Opal Note"
      {...props}
    >
      <rect width="64" height="64" rx="16" fill="#F8F5EC" />
      <rect
        x="0.75"
        y="0.75"
        width="62.5"
        height="62.5"
        rx="15.25"
        fill="none"
        stroke="#E8E1D3"
        strokeWidth="1.5"
      />
      <g
        fill="none"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M15 32A17 17 0 0 1 29.05 15.26" stroke="#F0645A" />
        <path d="M32 15A17 17 0 0 1 48.74 29.05" stroke="#3FBF7F" />
        <path d="M49 32A17 17 0 0 1 34.95 48.74" stroke="#3B82F6" />
        <path d="M32 49A17 17 0 0 1 15.26 34.95" stroke="#F3A43B" />
      </g>
    </svg>
  );
}
