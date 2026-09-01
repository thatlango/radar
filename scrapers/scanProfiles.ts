export type ScanProfile = {
  id: string;
  name: string;
  description: string;
  opportunityTypes: string[];
  keywords: string[];
  geographies: string[];
  minDaysToDeadline: number;
  priorityDomains: string[];
};

export const RADAR_SOURCE_CATALOG = [
  { name: 'LinkedIn', domain: 'linkedin.com', discovery: 'primary' },
  { name: 'Opportunity Desk', domain: 'opportunitydesk.org', discovery: 'primary' },
  { name: 'Global South Opportunities', domain: 'globalsouthopportunities.com', discovery: 'primary' },
  { name: 'UNGM', domain: 'ungm.org', discovery: 'primary' },
  { name: 'ReliefWeb', domain: 'reliefweb.int', discovery: 'primary' },
  { name: 'DevNetJobs', domain: 'devnetjobs.org', discovery: 'secondary' },
  { name: 'DevelopmentAid', domain: 'developmentaid.org', discovery: 'secondary' },
  { name: 'Devex', domain: 'devex.com', discovery: 'secondary' },
  { name: 'Assortis', domain: 'assortis.com', discovery: 'secondary' },
  { name: 'dgMarket', domain: 'dgmarket.com', discovery: 'secondary' },
  { name: 'GlobalTenders', domain: 'globaltenders.com', discovery: 'secondary' },
  { name: 'TendersOnTime', domain: 'tendersontime.com', discovery: 'secondary' },
  { name: 'TenderImpulse', domain: 'tenderimpulse.com', discovery: 'secondary' },
  { name: 'GIZ', domain: 'giz.de', discovery: 'primary' },
  { name: 'World Bank', domain: 'worldbank.org', discovery: 'primary' },
  { name: 'IFC', domain: 'ifc.org', discovery: 'primary' },
  { name: 'AfDB', domain: 'afdb.org', discovery: 'primary' },
  { name: 'Enabel', domain: 'enabel.be', discovery: 'primary' },
  { name: 'Mercy Corps', domain: 'mercycorps.org', discovery: 'primary' },
  { name: 'Palladium', domain: 'thepalladiumgroup.com', discovery: 'secondary' },
  { name: 'DAI', domain: 'dai.com', discovery: 'secondary' },
  { name: 'TechnoServe', domain: 'technoserve.org', discovery: 'primary' },
  { name: 'SNV', domain: 'snv.org', discovery: 'primary' },
  { name: 'Swisscontact', domain: 'swisscontact.org', discovery: 'primary' },
  { name: 'FHI 360', domain: 'fhi360.org', discovery: 'secondary' },
  { name: 'Save the Children', domain: 'savethechildren.net', discovery: 'primary' },
  { name: 'Oxfam', domain: 'oxfam.org', discovery: 'primary' },
  { name: 'UNDP', domain: 'undp.org', discovery: 'primary' },
  { name: 'UNICEF', domain: 'unicef.org', discovery: 'primary' },
  { name: 'ILO', domain: 'ilo.org', discovery: 'primary' },
  { name: 'UNIDO', domain: 'unido.org', discovery: 'primary' },
  { name: 'IUCN', domain: 'iucn.org', discovery: 'primary' },
  { name: 'NITA-U', domain: 'nita.go.ug', discovery: 'primary' },
  { name: 'PPDA Uganda', domain: 'ppda.go.ug', discovery: 'primary' },
] as const;

const DEVELOPMENT_METHOD_KEYWORDS = [
  'consultancy', 'consultant', 'technical assistance', 'advisory', 'programme design',
  'program design', 'programme implementation', 'program implementation', 'capacity building',
  'institutional strengthening', 'business development services', 'BDS', 'private sector development',
  'enterprise development', 'MSME', 'SME', 'entrepreneurship', 'innovation ecosystem', 'incubation',
  'acceleration', 'mentorship', 'coaching', 'market systems', 'livelihoods', 'youth employment',
  'Theory of Change', 'results framework', 'MEL', 'monitoring evaluation learning', 'baseline',
  'endline', 'evaluation', 'feasibility study', 'market assessment', 'ecosystem assessment',
  'digital transformation', 'e-government', 'digital skills', 'AI for development', 'research',
  'policy', 'organisational development', 'organizational development', 'change management',
  'training of trainers', 'ToT', 'curriculum', 'human centred design', 'human-centered design',
  'programme management', 'PMO', 'framework agreement', 'roster', 'institutional services',
];

export const SCAN_PROFILES: ScanProfile[] = [
  {
    id: 'consulting-firm',
    name: 'Consulting & implementation opportunities',
    description: 'Firm-level, framework, roster and consortium opportunities where a multidisciplinary team can lead methodology and recruit domain specialists.',
    opportunityTypes: ['consultancy', 'tender', 'grant'],
    keywords: DEVELOPMENT_METHOD_KEYWORDS,
    geographies: ['Uganda', 'East Africa', 'Africa', 'Remote', 'Global'],
    minDaysToDeadline: 7,
    priorityDomains: RADAR_SOURCE_CATALOG.map((source) => source.domain),
  },
  {
    id: 'strong-fit-role',
    name: 'Strong-fit roles & individual consultancies',
    description: 'Paid roles and individual consultancies in programme management, MSME development, innovation, livelihoods, capacity building, MEL and digital transformation.',
    opportunityTypes: ['job', 'consultancy'],
    keywords: [
      'programme manager', 'program manager', 'enterprise development', 'MSME', 'innovation',
      'livelihoods', 'capacity building', 'partnerships', 'MEL', 'learning', 'digital transformation',
      'youth employment', 'private sector development', 'business development services',
    ],
    geographies: ['Remote', 'Africa', 'East Africa', 'Uganda'],
    minDaysToDeadline: 5,
    priorityDomains: RADAR_SOURCE_CATALOG.map((source) => source.domain),
  },
  {
    id: 'innovation-entrepreneurship',
    name: 'Innovation & entrepreneurship',
    description: 'Innovation ecosystems, accelerators, incubators, entrepreneurship programmes, venture support and enterprise growth opportunities.',
    opportunityTypes: ['consultancy', 'tender', 'grant', 'job'],
    keywords: [
      'innovation ecosystem', 'entrepreneurship', 'accelerator', 'incubator', 'venture building',
      'startup support', 'enterprise development', 'MSME', 'SME growth', 'business advisory',
      'investment readiness', 'market systems', 'private sector development',
    ],
    geographies: ['Uganda', 'East Africa', 'Africa', 'Remote', 'Global'],
    minDaysToDeadline: 7,
    priorityDomains: RADAR_SOURCE_CATALOG.map((source) => source.domain),
  },
];

export function getScanProfile(id?: string | null): ScanProfile {
  return SCAN_PROFILES.find((profile) => profile.id === id) || SCAN_PROFILES[0];
}

export function buildDiscoveryQueries(profile: ScanProfile, customIntent?: string, customSkills: string[] = []): string[] {
  const intent = String(customIntent || '').trim();
  const skills = customSkills.filter(Boolean).slice(0, 10).join(' OR ');
  const core = profile.keywords.slice(0, 18);
  const queries = [
    `(${core.slice(0, 6).map((x) => `\"${x}\"`).join(' OR ')}) (RFP OR EOI OR consultancy OR tender) Africa`,
    `(${core.slice(6, 12).map((x) => `\"${x}\"`).join(' OR ')}) (consultant OR firm OR technical assistance) Uganda OR Kenya OR Rwanda OR Tanzania`,
    `(${core.slice(12, 18).map((x) => `\"${x}\"`).join(' OR ')}) (deadline OR apply OR procurement) Africa`,
  ];
  if (intent) queries.unshift(`\"${intent.slice(0, 180)}\" opportunities consultancy OR job OR grant Africa`);
  if (skills) queries.push(`(${skills}) opportunities Africa remote consultancy`);
  return queries.slice(0, 6);
}
