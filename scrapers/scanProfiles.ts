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

export type RadarSourceDefinition = {
  name: string;
  domain: string;
  discovery: 'primary' | 'secondary';
  adapter: 'rss' | 'page' | 'search' | 'indico' | 'linkedin' | 'afdb' | 'worldbank' | 'ugandagpp' | 'eufunding' | 'grantsgov' | 'unpartner' | 'brightermonday' | 'impactpool' | 'euraxess' | 'idrc' | 'grandchallenges';
  trust: 'official' | 'curated' | 'secondary';
  baseUrl?: string;
  feedUrl?: string;
  pages?: string[];
  defaultType?: 'job' | 'fellowship' | 'consultancy' | 'grant' | 'tender' | 'supply' | 'conference';
  defaultCountry?: string;
  organization?: string;
  requireOpportunityKeyword?: boolean;
  frequency?: 'hourly' | 'daily' | 'weekly';
  scanProfile?: string;
};

// Radar uses two acquisition layers:
// 1) keyless public feeds/pages and official open listings (always-on baseline), and
// 2) search-provider discovery for sources without reusable feeds/APIs (optional booster).
export const RADAR_SOURCE_CATALOG: RadarSourceDefinition[] = [
  // Curated opportunity feeds used in the user's manual Radar scans.
  { name: 'Opportunity Desk', domain: 'opportunitydesk.org', discovery: 'primary', adapter: 'rss', trust: 'curated', baseUrl: 'https://opportunitydesk.org/', feedUrl: 'https://opportunitydesk.org/feed/', frequency: 'hourly' },
  { name: 'ICTworks', domain: 'ictworks.org', discovery: 'primary', adapter: 'rss', trust: 'curated', baseUrl: 'https://www.ictworks.org/', feedUrl: 'https://www.ictworks.org/feed/', frequency: 'daily' },
  { name: 'TechCabal', domain: 'techcabal.com', discovery: 'primary', adapter: 'rss', trust: 'curated', baseUrl: 'https://techcabal.com/', feedUrl: 'https://techcabal.com/feed/', frequency: 'daily' },
  { name: 'Opportunities for Africans', domain: 'opportunitiesforafricans.com', discovery: 'primary', adapter: 'rss', trust: 'curated', baseUrl: 'https://www.opportunitiesforafricans.com/', feedUrl: 'https://www.opportunitiesforafricans.com/feed/', frequency: 'hourly' },
  { name: 'fundsforNGOs', domain: 'fundsforngos.org', discovery: 'primary', adapter: 'rss', trust: 'curated', baseUrl: 'https://www2.fundsforngos.org/', feedUrl: 'https://www2.fundsforngos.org/feed/', defaultType: 'grant', frequency: 'daily' },
  { name: 'VC4A', domain: 'vc4a.com', discovery: 'primary', adapter: 'rss', trust: 'curated', baseUrl: 'https://vc4a.com/', feedUrl: 'https://vc4a.com/feed/', frequency: 'daily' },
  { name: 'Terra Viva Grants', domain: 'terravivagrants.org', discovery: 'primary', adapter: 'rss', trust: 'curated', baseUrl: 'https://www.terravivagrants.org/', feedUrl: 'https://www.terravivagrants.org/feed/', defaultType: 'grant', frequency: 'daily' },
  { name: 'Opportunities for Youth', domain: 'opportunitiesforyouth.org', discovery: 'secondary', adapter: 'rss', trust: 'curated', baseUrl: 'https://opportunitiesforyouth.org/', feedUrl: 'https://opportunitiesforyouth.org/feed/', frequency: 'daily' },
  { name: 'JobsToApply.com', domain: 'jobstoapply.com', discovery: 'primary', adapter: 'page', trust: 'curated', baseUrl: 'https://jobstoapply.com/', pages: ['https://jobstoapply.com/','https://jobstoapply.com/?ao_page=2','https://jobstoapply.com/?ao_page=3','https://jobstoapply.com/?ao_page=4','https://jobstoapply.com/?ao_page=5','https://jobstoapply.com/?ao_page=6','https://jobstoapply.com/?ao_page=7','https://jobstoapply.com/?ao_page=8'], defaultType: 'job', frequency: 'hourly' },
  { name: 'UN Conferences & Participation', domain: 'indico.un.org', discovery: 'primary', adapter: 'indico', trust: 'official', baseUrl: 'https://indico.un.org/', defaultType: 'conference', frequency: 'hourly', scanProfile: 'conference-participation' },

  // Structured funding, partnership and specialist opportunity sources.
  { name: 'EU Funding & Tenders — Grants & Calls', domain: 'ec.europa.eu', discovery: 'primary', adapter: 'eufunding', trust: 'official', baseUrl: 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-search', defaultType: 'grant', organization: 'European Commission', frequency: 'daily' },
  { name: 'Grants.gov', domain: 'grants.gov', discovery: 'primary', adapter: 'grantsgov', trust: 'official', baseUrl: 'https://www.grants.gov/search-grants', defaultType: 'grant', organization: 'U.S. Federal Government', frequency: 'daily' },
  { name: 'UN Partner Portal', domain: 'unpartnerportal.org', discovery: 'primary', adapter: 'unpartner', trust: 'official', baseUrl: 'https://www.unpartnerportal.org/landing/opportunities/', defaultType: 'grant', organization: 'United Nations', frequency: 'daily' },
  { name: 'BrighterMonday Uganda', domain: 'brightermonday.co.ug', discovery: 'primary', adapter: 'brightermonday', trust: 'curated', baseUrl: 'https://www.brightermonday.co.ug/jobs', defaultType: 'job', defaultCountry: 'Uganda', frequency: 'hourly' },
  { name: 'Impactpool', domain: 'impactpool.org', discovery: 'primary', adapter: 'impactpool', trust: 'curated', baseUrl: 'https://www.impactpool.org/search', defaultType: 'job', frequency: 'hourly' },
  { name: 'EURAXESS Jobs & Research Opportunities', domain: 'euraxess.ec.europa.eu', discovery: 'primary', adapter: 'euraxess', trust: 'official', baseUrl: 'https://euraxess.ec.europa.eu/jobs/search', defaultType: 'job', frequency: 'hourly' },
  { name: 'IDRC Funding', domain: 'idrc-crdi.ca', discovery: 'primary', adapter: 'idrc', trust: 'official', baseUrl: 'https://idrc-crdi.ca/en/funding', defaultType: 'grant', organization: 'International Development Research Centre (IDRC)', frequency: 'daily' },
  { name: 'Grand Challenges', domain: 'grandchallenges.org', discovery: 'primary', adapter: 'grandchallenges', trust: 'official', baseUrl: 'https://www.grandchallenges.org/grant-opportunities', defaultType: 'grant', organization: 'Grand Challenges', frequency: 'daily' },

  // Public/official listing pages. One lightweight fetch per page; no login or private portal scraping.
  { name: 'Global South Opportunities', domain: 'globalsouthopportunities.com', discovery: 'primary', adapter: 'search', trust: 'curated', baseUrl: 'https://www.globalsouthopportunities.com/', frequency: 'hourly' },
  { name: 'UNDP Procurement Notices', domain: 'procurement-notices.undp.org', discovery: 'primary', adapter: 'page', trust: 'official', baseUrl: 'https://procurement-notices.undp.org/', pages: ['https://procurement-notices.undp.org/'], defaultType: 'tender', organization: 'UNDP', frequency: 'daily' },
  { name: 'UNDP Jobs', domain: 'jobs.undp.org', discovery: 'primary', adapter: 'page', trust: 'official', baseUrl: 'https://jobs.undp.org/cj_view_jobs.cfm', pages: ['https://jobs.undp.org/cj_view_jobs.cfm'], organization: 'UNDP', frequency: 'daily' },
  { name: 'UN Global Marketplace', domain: 'ungm.org', discovery: 'primary', adapter: 'search', trust: 'official', baseUrl: 'https://www.ungm.org/Public/Notice', defaultType: 'tender', organization: 'United Nations', frequency: 'daily' },
  { name: 'World Bank Procurement Notices', domain: 'worldbank.org', discovery: 'primary', adapter: 'worldbank', trust: 'official', baseUrl: 'https://search.worldbank.org/api/v2/procnotices', defaultType: 'tender', organization: 'World Bank', frequency: 'daily' },
  { name: 'Uganda Government Procurement Portal', domain: 'gpp.ppda.go.ug', discovery: 'primary', adapter: 'ugandagpp', trust: 'official', baseUrl: 'https://cdn.ppda.go.ug/api/tender/notices', defaultType: 'tender', defaultCountry: 'Uganda', organization: 'Government of Uganda', frequency: 'daily' },
  { name: 'NITA-U Bids & Tenders', domain: 'nita.go.ug', discovery: 'primary', adapter: 'page', trust: 'official', baseUrl: 'https://nita.go.ug/Opportunities/bids-and-tenders', pages: ['https://nita.go.ug/Opportunities/bids-and-tenders'], defaultType: 'tender', defaultCountry: 'Uganda', organization: 'NITA-U', frequency: 'daily' },
  { name: 'Uganda Communications Commission Tenders', domain: 'ucc.co.ug', discovery: 'primary', adapter: 'page', trust: 'official', baseUrl: 'https://www.ucc.co.ug/tenders/', pages: ['https://www.ucc.co.ug/tenders/'], defaultType: 'tender', defaultCountry: 'Uganda', organization: 'Uganda Communications Commission', frequency: 'daily' },
  { name: 'GIZ Uganda Tenders', domain: 'giz.de', discovery: 'primary', adapter: 'page', trust: 'official', baseUrl: 'https://www.giz.de/en/regions/africa/uganda/tenders', pages: ['https://www.giz.de/en/regions/africa/uganda/tenders'], defaultType: 'tender', defaultCountry: 'Uganda', organization: 'GIZ', frequency: 'daily' },
  { name: 'GIZ Ghana Tenders', domain: 'giz.de', discovery: 'primary', adapter: 'page', trust: 'official', baseUrl: 'https://www.giz.de/en/regions/africa/ghana/tenders', pages: ['https://www.giz.de/en/regions/africa/ghana/tenders'], defaultType: 'tender', defaultCountry: 'Ghana', organization: 'GIZ', frequency: 'daily' },
  { name: 'GIZ Southern Africa Tenders', domain: 'giz.de', discovery: 'secondary', adapter: 'page', trust: 'official', baseUrl: 'https://www.giz.de/en/regions/africa/south-africa/tenders', pages: ['https://www.giz.de/en/regions/africa/south-africa/tenders'], defaultType: 'tender', defaultCountry: 'South Africa', organization: 'GIZ', frequency: 'daily' },
  { name: 'African Union Bids', domain: 'au.int', discovery: 'primary', adapter: 'page', trust: 'official', baseUrl: 'https://au.int/en/bids', pages: ['https://au.int/en/bids'], defaultType: 'tender', defaultCountry: 'Africa', organization: 'African Union', frequency: 'daily' },
  { name: 'GIZ African Union e-Tendering', domain: 'au.giz.de', discovery: 'secondary', adapter: 'page', trust: 'official', baseUrl: 'https://au.giz.de/', pages: ['https://au.giz.de/'], defaultType: 'tender', defaultCountry: 'Africa', organization: 'GIZ African Union', frequency: 'daily' },

  // Dedicated adapters. LinkedIn is only activated when a licensed/configured jobs API exists.
  { name: 'LinkedIn', domain: 'linkedin.com', discovery: 'primary', adapter: 'linkedin', trust: 'secondary', baseUrl: 'https://www.linkedin.com/jobs/', frequency: 'daily' },
  { name: 'African Development Bank', domain: 'afdb.org', discovery: 'primary', adapter: 'search', trust: 'official', baseUrl: 'https://www.afdb.org/en/careers/current-job-openings', frequency: 'daily' },

  // Search-provider expansion. These become independently monitored when Brave/Serper is configured.
  { name: 'ReliefWeb', domain: 'reliefweb.int', discovery: 'primary', adapter: 'search', trust: 'curated' },
  { name: 'ProFellow', domain: 'profellow.com', discovery: 'secondary', adapter: 'search', trust: 'curated', baseUrl: 'https://www.profellow.com/fellowships/' },
  { name: 'AECF Funding Opportunities', domain: 'aecfafrica.org', discovery: 'primary', adapter: 'search', trust: 'official', baseUrl: 'https://www.aecfafrica.org/im-looking-to/see-aecfs-funding-opportunities/', defaultType: 'grant' },
  { name: 'GSMA Innovation Fund', domain: 'gsma.com', discovery: 'primary', adapter: 'search', trust: 'official', baseUrl: 'https://www.gsma.com/solutions-and-impact/connectivity-for-good/mobile-for-development/gsma-innovation-fund/', defaultType: 'grant' },
  { name: 'UNjobs', domain: 'unjobs.org', discovery: 'primary', adapter: 'search', trust: 'curated', baseUrl: 'https://unjobs.org/' },
  { name: 'Devex', domain: 'devex.com', discovery: 'primary', adapter: 'search', trust: 'curated' },
  { name: 'DevNetJobs', domain: 'devnetjobs.org', discovery: 'secondary', adapter: 'search', trust: 'curated' },
  { name: 'DevelopmentAid', domain: 'developmentaid.org', discovery: 'secondary', adapter: 'search', trust: 'curated' },
  { name: 'Assortis', domain: 'assortis.com', discovery: 'secondary', adapter: 'search', trust: 'curated' },
  { name: 'dgMarket', domain: 'dgmarket.com', discovery: 'secondary', adapter: 'search', trust: 'curated' },
  { name: 'GlobalTenders', domain: 'globaltenders.com', discovery: 'secondary', adapter: 'search', trust: 'curated' },
  { name: 'TendersOnTime', domain: 'tendersontime.com', discovery: 'secondary', adapter: 'search', trust: 'curated' },
  { name: 'TenderImpulse', domain: 'tenderimpulse.com', discovery: 'secondary', adapter: 'search', trust: 'curated' },
  { name: 'IFC', domain: 'ifc.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'UNICEF', domain: 'unicef.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'ILO', domain: 'ilo.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'UNIDO', domain: 'unido.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'UNOPS', domain: 'unops.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'IOM', domain: 'iom.int', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'IFAD', domain: 'ifad.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'IUCN', domain: 'iucn.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'Enabel', domain: 'enabel.be', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'Mercy Corps', domain: 'mercycorps.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'Palladium', domain: 'thepalladiumgroup.com', discovery: 'secondary', adapter: 'search', trust: 'official' },
  { name: 'DAI', domain: 'dai.com', discovery: 'secondary', adapter: 'search', trust: 'official' },
  { name: 'Chemonics', domain: 'chemonics.com', discovery: 'secondary', adapter: 'search', trust: 'official' },
  { name: 'DT Global', domain: 'dt-global.com', discovery: 'secondary', adapter: 'search', trust: 'official' },
  { name: 'Tetra Tech International Development', domain: 'tetratech.com', discovery: 'secondary', adapter: 'search', trust: 'official' },
  { name: 'Abt Global', domain: 'abtglobal.com', discovery: 'secondary', adapter: 'search', trust: 'official' },
  { name: 'TechnoServe', domain: 'technoserve.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'SNV', domain: 'snv.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'Swisscontact', domain: 'swisscontact.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'FHI 360', domain: 'fhi360.org', discovery: 'secondary', adapter: 'search', trust: 'official' },
  { name: 'Save the Children', domain: 'savethechildren.net', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'Oxfam', domain: 'oxfam.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'CARE', domain: 'care.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'International Rescue Committee', domain: 'rescue.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'Catholic Relief Services', domain: 'crs.org', discovery: 'secondary', adapter: 'search', trust: 'official' },
  { name: 'Plan International', domain: 'plan-international.org', discovery: 'secondary', adapter: 'search', trust: 'official' },
  { name: 'Heifer International', domain: 'heifer.org', discovery: 'secondary', adapter: 'search', trust: 'official' },
  { name: 'Mastercard Foundation', domain: 'mastercardfdn.org', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'GSMA', domain: 'gsma.com', discovery: 'secondary', adapter: 'search', trust: 'official' },
  { name: 'East African Community', domain: 'eac.int', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'COMESA', domain: 'comesa.int', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'IGAD', domain: 'igad.int', discovery: 'primary', adapter: 'search', trust: 'official' },
  { name: 'TradeMark Africa', domain: 'trademarkafrica.com', discovery: 'primary', adapter: 'search', trust: 'official' },
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
    id: 'funding-grants',
    name: 'Grants, funding & challenge capital',
    description: 'Grants, calls for proposals, innovation funds, challenge awards, research funding and institutional partnership opportunities.',
    opportunityTypes: ['grant'],
    keywords: ['grant', 'funding', 'call for proposals', 'challenge fund', 'innovation fund', 'research funding', 'prize', 'award', 'partnership call', 'accelerator funding', 'seed funding', 'open call'],
    geographies: ['Uganda', 'East Africa', 'Africa', 'Global South', 'Global'],
    minDaysToDeadline: 7,
    priorityDomains: RADAR_SOURCE_CATALOG.map((source) => source.domain),
  },
  {
    id: 'fellowships-growth',
    name: 'Fellowships & professional growth',
    description: 'Funded fellowships, leadership programmes, research fellowships, scholarships, residencies, PhD/postdoc opportunities and professional exchanges.',
    opportunityTypes: ['fellowship'],
    keywords: ['fellowship', 'leadership programme', 'leadership program', 'research fellowship', 'scholarship', 'residency', 'exchange programme', 'PhD', 'doctoral', 'postdoc', 'professional fellowship', 'travel award'],
    geographies: ['Uganda', 'East Africa', 'Africa', 'Global South', 'Global'],
    minDaysToDeadline: 7,
    priorityDomains: RADAR_SOURCE_CATALOG.map((source) => source.domain),
  },
  {
    id: 'conference-participation',
    name: 'Conferences, summits & funded participation',
    description: 'Conferences and summits with open registration, calls for participants, speakers, papers/abstracts, delegates or funded travel support.',
    opportunityTypes: ['conference'],
    keywords: ['conference registration', 'call for participants', 'call for papers', 'call for abstracts', 'call for speakers', 'travel grant', 'funded participation', 'delegate application', 'summit application', 'conference scholarship'],
    geographies: ['Uganda', 'East Africa', 'Africa', 'Global South', 'Global'],
    minDaysToDeadline: 3,
    priorityDomains: ['indico.un.org','un.org','itu.int','unesco.org','unfccc.int','au.int','worldbank.org'],
  },
  {
    id: 'procurement-supplies',
    name: 'Procurement, supplies & vendor opportunities',
    description: 'Tenders, RFQs, supplier prequalification, framework agreements and procurement of goods, equipment and supplies.',
    opportunityTypes: ['tender', 'supply'],
    keywords: ['request for quotation', 'RFQ', 'supplier prequalification', 'vendor prequalification', 'supply of', 'procurement of goods', 'framework agreement', 'invitation to bid', 'tender notice', 'bid invitation'],
    geographies: ['Uganda', 'East Africa', 'Africa', 'Global'],
    minDaysToDeadline: 3,
    priorityDomains: ['gpp.ppda.go.ug','ungm.org','procurement-notices.undp.org','worldbank.org','afdb.org','au.int'],
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
  if (profile.id === 'conference-participation') return [
    '("call for participants" OR "conference registration" OR "summit registration") (Africa OR Uganda OR "East Africa") 2026',
    '("call for papers" OR "call for abstracts" OR "call for speakers") conference Africa 2026',
    '("travel grant" OR "funded participation" OR "conference scholarship") conference OR summit Africa 2026',
    '("delegate application" OR "participant registration") summit OR forum OR conference Africa 2026',
  ];
  if (profile.id === 'procurement-supplies') return [
    '(RFQ OR "request for quotation" OR "supplier prequalification") (Uganda OR Kenya OR Rwanda OR Tanzania)',
    '("supply of" OR "procurement of goods" OR "vendor prequalification") Africa deadline',
    '("framework agreement" OR "invitation to bid" OR tender) supplies OR equipment Africa',
    '(procurement OR tender OR RFQ) (goods OR supplies OR equipment) Uganda',
  ];
  const skills = customSkills.filter(Boolean).slice(0, 10).join(' OR ');
  const core = profile.keywords.slice(0, 24);
  const queries = [
    `(${core.slice(0, 6).map((x) => `\"${x}\"`).join(' OR ')}) (RFP OR EOI OR consultancy OR tender) Africa`,
    `(${core.slice(6, 12).map((x) => `\"${x}\"`).join(' OR ')}) (consultant OR firm OR technical assistance) Uganda OR Kenya OR Rwanda OR Tanzania`,
    `(${core.slice(12, 18).map((x) => `\"${x}\"`).join(' OR ')}) (deadline OR apply OR procurement) Africa`,
    `(${core.slice(18, 24).map((x) => `\"${x}\"`).join(' OR ')}) (remote OR global OR Africa) (consultancy OR job OR grant)`,
  ];
  if (intent) queries.unshift(`\"${intent.slice(0, 180)}\" opportunities consultancy OR job OR grant Africa`);
  if (skills) queries.push(`(${skills}) opportunities Africa remote consultancy`);
  return queries.slice(0, 7);
}