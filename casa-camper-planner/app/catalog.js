// Fonti esterne di aree sosta e campeggi che l'app può scaricare da sola.
// Solo dati aperti con coordinate. L'Umbrel li scarica direttamente dal portale.

const ods = (domain, id) => `https://${domain}/api/explore/v2.1/catalog/datasets/${id}/exports/geojson`;

export const CATALOG = [
  {
    id: 'fr-pdl-aires',
    name: 'Aree camper — Pays de la Loire',
    country: 'FR', category: 'area_camper',
    url: ods('data.paysdelaloire.fr', '234400034_070-001_offre-touristique-aires-de-camping-car-rpdl'),
    page: 'https://data.paysdelaloire.fr/explore/dataset/234400034_070-001_offre-touristique-aires-de-camping-car-rpdl/',
    licence: 'ODbL', attribution: 'Région des Pays de la Loire — réseau e-SPRIT',
    updated: 'quotidiano'
  },
  {
    id: 'fr-pdl-campings',
    name: 'Campeggi — Pays de la Loire',
    country: 'FR', category: 'campeggio',
    url: ods('data.paysdelaloire.fr', '234400034_070-005_offre-touristique-hotelleries-de-plein-air-rpdl'),
    page: 'https://data.paysdelaloire.fr/explore/dataset/234400034_070-005_offre-touristique-hotelleries-de-plein-air-rpdl/',
    licence: 'vedi pagina', attribution: 'Région des Pays de la Loire — réseau e-SPRIT',
    updated: 'quotidiano'
  },
  {
    id: 'fr-cvl-aires',
    name: 'Aree camper — Centre-Val de Loire',
    country: 'FR', category: 'area_camper',
    url: ods('data.centrevaldeloire.fr', 'aires-de-camping-car-en-region-centre-val-de-loire'),
    page: 'https://data.centrevaldeloire.fr/explore/dataset/aires-de-camping-car-en-region-centre-val-de-loire/',
    licence: 'Licence Ouverte 2.0', attribution: 'Comité Régional du Tourisme Centre-Val de Loire — Tourinsoft',
    updated: 'mensile'
  },
  {
    id: 'fr-cvl-campings',
    name: 'Campeggi — Centre-Val de Loire',
    country: 'FR', category: 'campeggio',
    url: ods('data.centrevaldeloire.fr', 'hotellerie-de-plein-air-en-region-centre-val-de-loire'),
    page: 'https://data.centrevaldeloire.fr/explore/dataset/hotellerie-de-plein-air-en-region-centre-val-de-loire/',
    licence: 'Licence Ouverte 2.0', attribution: 'Comité Régional du Tourisme Centre-Val de Loire — Tourinsoft',
    updated: 'mensile'
  },
  {
    id: 'fr-herault-aires',
    name: 'Aree camper — Hérault',
    country: 'FR', category: 'area_camper',
    url: ods('www.herault-data.fr', 'aires-de-camping-car'),
    page: 'https://www.herault-data.fr/explore/dataset/aires-de-camping-car/',
    licence: 'vedi pagina', attribution: 'Hérault Tourisme',
    updated: 'periodico'
  },
  {
    id: 'es-euskadi-campings',
    name: 'Campeggi — Paesi Baschi (Euskadi)',
    country: 'ES', category: 'campeggio',
    url: 'https://opendata.euskadi.eus/contenidos/ds_recursos_turisticos/campings_de_euskadi/opendata/alojamientos.geojson',
    page: 'https://opendata.euskadi.eus/catalogo/-/campings-de-euskadi/',
    licence: 'CC BY 4.0', attribution: 'Gobierno Vasco — Open Data Euskadi',
    updated: 'quotidiano'
  }
];

// Fonti da scaricare a mano (dati gratuiti ma per uso personale, o che richiedono un account).
export const MANUAL_SOURCES = [
  {
    name: 'Archies Campings', country: 'Europa',
    what: 'Oltre 30.000 campeggi in tutta Europa, file POI gratuiti per navigatori',
    page: 'http://www.archiescampings.eu/eng1/',
    how: 'Scarica la versione per Garmin (CSV) o GPX e importala qui. Uso personale.'
  },
  {
    name: 'DATAtourisme', country: 'FR',
    what: 'Tutta l\'offerta turistica francese (aree camper e campeggi compresi), Licence Ouverte',
    page: 'https://www.datatourisme.fr/',
    how: 'Crea un account gratuito, prepara un flusso filtrato su "Aire de camping-car" e "Camping" in formato CSV o JSON e incolla qui il suo indirizzo.'
  },
  {
    name: 'Areas AC', country: 'ES',
    what: 'Aree di servizio e parcheggi per autocaravan in Spagna, file POI',
    page: 'https://www.areasac.es/areas-para-autocaravanas/areasaces/descargas_1497_1_ap.html',
    how: 'Scarica il file POI (GPX o CSV) dalla pagina Descargas e importalo qui. Rispetta le condizioni del sito.'
  },
  {
    name: 'Mappe Google My Maps', country: '—',
    what: 'Liste di aree sosta condivise da club e community',
    page: 'https://www.google.com/maps/d/',
    how: 'Apri la mappa → menu ⋮ → Scarica KML (spunta "Esporta in KML") e importa il file.'
  }
];
