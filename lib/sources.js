// Source categories and the vetted domain lists used to label and filter search results.
// Edit these lists to tune what counts as "credible" for Research mode.

export const CATEGORIES = {
  web:       { label: 'Google Search (whole web)', credible: false },
  academic:  { label: 'Academic & journals',       credible: true },
  gov:       { label: 'Government & official',     credible: true },
  news:      { label: 'Trusted news',              credible: true },
  reference: { label: 'Reference & docs',          credible: true },
};

export const CREDIBLE_DEFAULT = ['academic', 'gov', 'news', 'reference'];

// Hints that steer Google Search queries toward each category.
export const SEARCH_HINTS = {
  academic: 'peer-reviewed journals, university (.edu, .ac.*) sites, PubMed/NIH, arXiv, Nature, Science, IEEE, ACM, JSTOR',
  gov: 'government (.gov, .gov.uk, .gc.ca, europa.eu) and intergovernmental sites (WHO, UN, World Bank, IMF, OECD)',
  news: 'established newsrooms with editorial standards (Reuters, AP, BBC, NPR, PBS, The New York Times, The Wall Street Journal, The Washington Post, Financial Times, The Economist, Bloomberg, The Guardian)',
  reference: 'established references and official documentation (Britannica, Wikipedia, Merriam-Webster, Mayo Clinic, Cleveland Clinic, NHS, MedlinePlus, MDN, official product and language docs)',
};

const ACADEMIC = [
  'arxiv.org', 'nature.com', 'science.org', 'sciencedirect.com', 'springer.com', 'link.springer.com',
  'wiley.com', 'onlinelibrary.wiley.com', 'tandfonline.com', 'sagepub.com', 'jstor.org', 'ieee.org',
  'ieeexplore.ieee.org', 'acm.org', 'dl.acm.org', 'thelancet.com', 'nejm.org', 'bmj.com', 'jamanetwork.com',
  'cell.com', 'plos.org', 'journals.plos.org', 'frontiersin.org', 'pnas.org', 'oup.com', 'academic.oup.com',
  'cambridge.org', 'biorxiv.org', 'medrxiv.org', 'ssrn.com', 'nber.org', 'semanticscholar.org',
  'scholar.google.com', 'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov', 'cochranelibrary.com',
  'annualreviews.org', 'aps.org', 'acs.org', 'pubs.acs.org', 'rsc.org', 'iop.org', 'mit.edu', 'stanford.edu',
];

const GOV = [
  'who.int', 'un.org', 'worldbank.org', 'imf.org', 'oecd.org', 'europa.eu', 'unesco.org', 'unicef.org',
  'wto.org', 'iaea.org', 'nato.int', 'ecb.europa.eu', 'bis.org', 'federalreserve.gov', 'ipcc.ch',
];

const NEWS = [
  'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'npr.org', 'pbs.org', 'nytimes.com', 'wsj.com',
  'washingtonpost.com', 'ft.com', 'economist.com', 'bloomberg.com', 'theguardian.com', 'cnbc.com',
  'axios.com', 'politico.com', 'aljazeera.com', 'theatlantic.com', 'latimes.com', 'usatoday.com',
  'cbsnews.com', 'nbcnews.com', 'abcnews.go.com', 'cnn.com', 'time.com', 'propublica.org',
  'scientificamerican.com', 'arstechnica.com', 'theverge.com', 'wired.com', 'techcrunch.com', 'forbes.com',
];

const REFERENCE = [
  'wikipedia.org', 'britannica.com', 'merriam-webster.com', 'dictionary.cambridge.org', 'oed.com',
  'mayoclinic.org', 'clevelandclinic.org', 'nhs.uk', 'hopkinsmedicine.org', 'investopedia.com',
  'developer.mozilla.org', 'docs.python.org', 'learn.microsoft.com', 'developer.apple.com',
  'developers.google.com', 'cloud.google.com', 'ai.google.dev', 'docs.aws.amazon.com', 'nodejs.org',
  'react.dev', 'pytorch.org', 'tensorflow.org', 'scikit-learn.org', 'pandas.pydata.org', 'numpy.org',
  'w3.org', 'ietf.org', 'rfc-editor.org', 'khanacademy.org', 'stats.stackexchange.com', 'stackoverflow.com',
  'github.com', 'docs.github.com', 'kaggle.com', 'huggingface.co', 'plato.stanford.edu', 'worldhistory.org',
  'history.com', 'nationalgeographic.com', 'smithsonianmag.com',
];

function matches(domain, list) {
  return list.some((d) => domain === d || domain.endsWith('.' + d));
}

// Turn a Gemini grounding chunk title/URL into a bare domain like "cdc.gov".
export function domainOf(title, uri) {
  const t = String(title || '').trim().toLowerCase();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t)) return t.replace(/^www\./, '');
  try {
    const host = new URL(uri).hostname.toLowerCase();
    if (!host.includes('vertexaisearch') && !host.includes('google')) return host.replace(/^www\./, '');
  } catch { /* fall through */ }
  return t.replace(/^www\./, '');
}

export function classify(domain) {
  const d = String(domain || '').toLowerCase();
  if (!d) return 'other';
  if (matches(d, ACADEMIC)) return 'academic'; // before .gov so PubMed/NCBI count as academic
  if (/\.(gov|mil)(\.[a-z]{2})?$/.test(d) || /\.gov\.[a-z]{2,3}$/.test(d) || /(^|\.)gc\.ca$/.test(d) || matches(d, GOV)) return 'gov';
  if (/\.edu(\.[a-z]{2})?$/.test(d) || /\.ac\.[a-z]{2}$/.test(d) || matches(d, ACADEMIC)) return 'academic';
  if (matches(d, NEWS)) return 'news';
  if (matches(d, REFERENCE)) return 'reference';
  return 'other';
}
