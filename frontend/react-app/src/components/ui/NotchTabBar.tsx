"use client";


import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export interface NotchTab {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
}

export interface NotchTabBarProps {
  tabs: readonly NotchTab[];
  activeId: string;
  onActiveChange: (id: string) => void;
}

export function NotchTabBar({ tabs, activeId, onActiveChange }: NotchTabBarProps) {
  return (
    <div className="relative flex items-center gap-1 bg-zinc-100 rounded-full p-1.5 w-fit">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeId === tab.id;

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onActiveChange(tab.id)}
            className={cn(
              "relative z-10 flex h-8 cursor-pointer items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors outline-none select-none",
              isActive
                ? "text-zinc-50"
                : "text-zinc-500 hover:text-zinc-700"
            )}
          >
            {isActive && (
              <motion.span
                layoutId="notch-tab-active"
                className="absolute inset-0 rounded-full bg-zinc-950 dark:bg-zinc-300"
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
              />
            )}

            <span className="relative z-10 flex items-center gap-2">
              {Icon && (
                <Icon
                  className={cn(
                    "size-4 shrink-0",
                    isActive
                      ? "text-zinc-50 dark:text-zinc-950"
                      : "text-zinc-400 dark:text-zinc-600"
                  )}
                />
              )}
              <span className="leading-none">{tab.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
