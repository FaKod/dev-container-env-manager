import React from 'react'
import {
  Server, Container, Database, Cloud, Globe, Monitor, Laptop, Terminal,
  Code, Cpu, HardDrive, Rocket, FlaskConical, Bug, Shield, Zap,
  Wrench, GitBranch, Package, Boxes, Network, Bot, Layers, Home
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Curated avatar icons, keyed by the value stored in Profile.icon.
export const PROFILE_ICONS: Record<string, LucideIcon> = {
  server: Server,
  container: Container,
  database: Database,
  cloud: Cloud,
  globe: Globe,
  monitor: Monitor,
  laptop: Laptop,
  terminal: Terminal,
  code: Code,
  cpu: Cpu,
  harddrive: HardDrive,
  rocket: Rocket,
  flask: FlaskConical,
  bug: Bug,
  shield: Shield,
  zap: Zap,
  wrench: Wrench,
  gitbranch: GitBranch,
  package: Package,
  boxes: Boxes,
  network: Network,
  bot: Bot,
  layers: Layers,
  home: Home
}

// Renders a profile's avatar icon, or null when unset/unknown so the caller
// can fall back to the first-letter avatar. Mirrors ContextIcon in TerminalTabs.
export function ProfileIcon({ icon, size = 15 }: { icon?: string; size?: number }): React.ReactElement | null {
  const Icon = icon ? PROFILE_ICONS[icon] : undefined
  return Icon ? <Icon size={size} /> : null
}
