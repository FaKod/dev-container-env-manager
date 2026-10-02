import React from 'react'
import {
  // AI & Agents
  Bot, BotMessageSquare, Brain, BrainCircuit, Sparkles, WandSparkles, Cpu,
  CircuitBoard, Binary, Workflow, Orbit,
  // Code & Dev
  Code, Terminal, GitBranch, GitMerge, GitPullRequest, Bug, Braces, FileCode,
  Hammer, Wrench, Puzzle, Blocks, Package, Boxes, Layers, Component, Regex,
  // Infrastructure
  Server, Database, Cloud, Container, HardDrive, Monitor, Laptop, Smartphone,
  Router, Wifi, Globe, SatelliteDish, Plug, Zap, Power, Gauge, Activity, Network,
  // Data & Analysis
  ChartBar, ChartLine, ChartPie, TrendingUp, Table, Sigma, Calculator, Search,
  ScanSearch, Filter,
  // Writing & Docs
  FileText, Files, BookOpen, NotebookPen, PenTool, Pencil, Feather, Languages,
  Type, ScrollText, Newspaper, Mail, MessageSquare, MessagesSquare, Quote,
  ClipboardList,
  // Media & Design
  Image, Camera, Video, Film, Clapperboard, Music, Mic, Headphones, Palette,
  Paintbrush, Shapes,
  // Automation & Ops
  Settings, Cog, Timer, Clock, Calendar, CalendarClock, RefreshCw, Repeat,
  Rocket, Send, Truck, Factory, Bell, ListChecks, Infinity as InfinityIcon,
  // Security
  Shield, ShieldCheck, Lock, KeyRound, Fingerprint, Eye, Scan, UserCheck, Siren,
  // Business & People
  Briefcase, Building2, Users, User, Handshake, DollarSign, CreditCard,
  ShoppingCart, Store, Landmark, Scale, Receipt, Presentation,
  // Science & Knowledge
  FlaskConical, TestTube, Microscope, Atom, Dna, Telescope, GraduationCap,
  Lightbulb, Target, Compass, Map as MapIcon, MapPin, Earth,
  // Home & Life
  Home, Coffee, Utensils, Pizza, Car, Plane, TreePine, Leaf, Sun, Moon, Star,
  Heart, Flame, Trophy, Gamepad2, Ghost, Gift, Umbrella,
  // Animals
  Cat, Dog, Bird, Fish, Rabbit, Turtle, Squirrel, Snail, PawPrint, Bone, Egg
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface ProfileIconGroup {
  label: string
  icons: Record<string, LucideIcon>
}

// Curated avatar icons for the profile editor picker, grouped by what an
// AI-agent dev environment might be for. Keys are what Profile.icon stores —
// never rename or remove a key without a fallback, saved profiles reference them.
export const PROFILE_ICON_GROUPS: ProfileIconGroup[] = [
  {
    label: 'AI & Agents',
    icons: {
      bot: Bot, botchat: BotMessageSquare, brain: Brain, braincircuit: BrainCircuit,
      sparkles: Sparkles, wand: WandSparkles, cpu: Cpu, circuitboard: CircuitBoard,
      binary: Binary, workflow: Workflow, orbit: Orbit
    }
  },
  {
    label: 'Code & Dev',
    icons: {
      code: Code, terminal: Terminal, gitbranch: GitBranch, gitmerge: GitMerge,
      pullrequest: GitPullRequest, bug: Bug, braces: Braces, filecode: FileCode,
      hammer: Hammer, wrench: Wrench, puzzle: Puzzle, blocks: Blocks,
      package: Package, boxes: Boxes, layers: Layers, component: Component,
      regex: Regex
    }
  },
  {
    label: 'Infrastructure',
    icons: {
      server: Server, database: Database, cloud: Cloud, container: Container,
      harddrive: HardDrive, monitor: Monitor, laptop: Laptop, smartphone: Smartphone,
      router: Router, wifi: Wifi, globe: Globe, satellite: SatelliteDish,
      plug: Plug, zap: Zap, power: Power, gauge: Gauge, activity: Activity,
      network: Network
    }
  },
  {
    label: 'Data & Analysis',
    icons: {
      barchart: ChartBar, linechart: ChartLine, piechart: ChartPie,
      trending: TrendingUp, table: Table, sigma: Sigma, calculator: Calculator,
      search: Search, scansearch: ScanSearch, filter: Filter
    }
  },
  {
    label: 'Writing & Docs',
    icons: {
      filetext: FileText, files: Files, book: BookOpen, notebook: NotebookPen,
      pentool: PenTool, pencil: Pencil, feather: Feather, languages: Languages,
      type: Type, scroll: ScrollText, newspaper: Newspaper, mail: Mail,
      message: MessageSquare, messages: MessagesSquare, quote: Quote,
      clipboard: ClipboardList
    }
  },
  {
    label: 'Media & Design',
    icons: {
      image: Image, camera: Camera, video: Video, film: Film,
      clapperboard: Clapperboard, music: Music, mic: Mic, headphones: Headphones,
      palette: Palette, brush: Paintbrush, shapes: Shapes
    }
  },
  {
    label: 'Automation & Ops',
    icons: {
      settings: Settings, cog: Cog, timer: Timer, clock: Clock, calendar: Calendar,
      calendarclock: CalendarClock, refresh: RefreshCw, repeat: Repeat,
      rocket: Rocket, send: Send, truck: Truck, factory: Factory, bell: Bell,
      listchecks: ListChecks, infinity: InfinityIcon
    }
  },
  {
    label: 'Security',
    icons: {
      shield: Shield, shieldcheck: ShieldCheck, lock: Lock, key: KeyRound,
      fingerprint: Fingerprint, eye: Eye, scan: Scan, usercheck: UserCheck,
      siren: Siren
    }
  },
  {
    label: 'Business & People',
    icons: {
      briefcase: Briefcase, building: Building2, users: Users, user: User,
      handshake: Handshake, dollar: DollarSign, creditcard: CreditCard,
      cart: ShoppingCart, store: Store, landmark: Landmark, scale: Scale,
      receipt: Receipt, presentation: Presentation
    }
  },
  {
    label: 'Science & Knowledge',
    icons: {
      flask: FlaskConical, testtube: TestTube, microscope: Microscope, atom: Atom,
      dna: Dna, telescope: Telescope, graduation: GraduationCap,
      lightbulb: Lightbulb, target: Target, compass: Compass, map: MapIcon,
      mappin: MapPin, earth: Earth
    }
  },
  {
    label: 'Home & Life',
    icons: {
      home: Home, coffee: Coffee, utensils: Utensils, pizza: Pizza, car: Car,
      plane: Plane, tree: TreePine, leaf: Leaf, sun: Sun, moon: Moon, star: Star,
      heart: Heart, flame: Flame, trophy: Trophy, gamepad: Gamepad2, ghost: Ghost,
      gift: Gift, umbrella: Umbrella
    }
  },
  {
    label: 'Animals',
    icons: {
      cat: Cat, dog: Dog, bird: Bird, fish: Fish, rabbit: Rabbit, turtle: Turtle,
      squirrel: Squirrel, snail: Snail, pawprint: PawPrint, bone: Bone, egg: Egg
    }
  }
]

// Flat lookup by stored key, used by the avatar renderers.
export const PROFILE_ICONS: Record<string, LucideIcon> = Object.assign(
  {},
  ...PROFILE_ICON_GROUPS.map((g) => g.icons)
)

// Renders a profile's avatar icon, or null when unset/unknown so the caller
// can fall back to the first-letter avatar. Mirrors ContextIcon in TerminalTabs.
export function ProfileIcon({ icon, size = 15 }: { icon?: string; size?: number }): React.ReactElement | null {
  const Icon = icon ? PROFILE_ICONS[icon] : undefined
  return Icon ? <Icon size={size} /> : null
}
