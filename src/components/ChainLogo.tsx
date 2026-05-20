import { cn } from "@/lib/utils";
import type { ChainInfo } from "@/lib/cctp";

export function ChainLogo({
  chain,
  size = 32,
  className,
}: {
  chain: ChainInfo;
  size?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center font-black text-white",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: chain.color,
        fontSize: size * 0.46,
      }}
    >
      {chain.logoChar}
      {chain.network === "testnet" ? (
        <span
          className="absolute -bottom-0.5 -right-0.5 size-2 border border-background bg-warning"
          aria-label="testnet"
        />
      ) : null}
    </div>
  );
}

export function UsdcLogo({
  size = 28,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      aria-label="USDC"
    >
      <circle cx="16" cy="16" r="16" fill="#2775CA" />
      <path
        fill="#FFF"
        d="M20.022 18.124c0-2.124-1.28-2.852-3.84-3.156-1.828-.243-2.193-.728-2.193-1.578 0-.85.61-1.396 1.828-1.396 1.097 0 1.706.364 2.011 1.275a.458.458 0 0 0 .427.303h.975a.416.416 0 0 0 .427-.425v-.06a3.04 3.04 0 0 0-2.743-2.49V9.142c0-.243-.183-.425-.487-.486h-.915c-.244 0-.428.182-.488.486v1.396c-1.829.242-2.986 1.456-2.986 2.974 0 2.002 1.218 2.791 3.779 3.095 1.707.303 2.255.668 2.255 1.639 0 .97-.853 1.638-2.011 1.638-1.585 0-2.133-.667-2.316-1.578-.061-.242-.244-.364-.427-.364h-1.036a.416.416 0 0 0-.426.425v.06c.243 1.518 1.218 2.61 3.23 2.913v1.457c0 .242.183.425.487.485h.915c.244 0 .427-.182.488-.485V21.34c1.829-.303 3.047-1.578 3.047-3.217z"
      />
      <path
        fill="#FFF"
        d="M12.633 25.273c-4.755-1.7-7.193-7-5.388-11.69.975-2.67 3.108-4.733 5.388-5.582.244-.121.366-.303.366-.607V6.55c0-.243-.122-.425-.366-.486-.061 0-.183 0-.244.06-5.754 1.82-8.923 7.948-7.071 13.713 1.097 3.4 3.717 6.01 7.071 7.099.244.121.488 0 .549-.243.061-.06.061-.121.061-.243v-.85c0-.182-.183-.424-.366-.546zm6.733-18.667c-.244-.122-.488 0-.549.242-.061.061-.061.122-.061.243v.85c0 .243.183.486.366.607 4.755 1.7 7.193 7 5.388 11.69-.975 2.67-3.108 4.733-5.388 5.583-.244.121-.366.303-.366.607v.849c0 .242.122.424.366.485.061 0 .183 0 .244-.06 5.754-1.821 8.923-7.95 7.071-13.713-1.097-3.46-3.778-6.07-7.071-7.16z"
      />
    </svg>
  );
}
