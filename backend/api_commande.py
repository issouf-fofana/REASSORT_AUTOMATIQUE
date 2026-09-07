#!/usr/bin/env python3
"""
Extracteur API Prosuma RPOS - Commandes Fournisseurs
Récupère toutes les commandes fournisseurs via l'API Prosuma avec pagination automatique
"""

import requests
import os
import csv
import json
import logging
import shutil
from datetime import datetime, timedelta
from dotenv import load_dotenv
import urllib3
import sys

# Ajouter le répertoire parent au path pour importer utils
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils import load_shop_config, build_network_path, create_network_folder, SafeStreamHandler

# Désactiver les warnings SSL
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

class ProsumaAPICommandeExtractor:
    def __init__(self):
        """Initialise l'extracteur avec la configuration"""
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        load_dotenv(os.path.join(project_root, 'config.env'))
        
        self.username = os.getenv('PROSUMA_USER')
        self.password = os.getenv('PROSUMA_PASSWORD')
        self.status_filter = os.getenv('STATUT_COMMANDE', '')
        
        if not self.username or not self.password:
            raise ValueError("PROSUMA_USER et PROSUMA_PASSWORD doivent être configurés dans config.env")
        
        # Configuration du dossier de téléchargement
        self.base_dir = os.path.dirname(os.path.abspath(__file__))
        self.network_folder_base = os.getenv('DOWNLOAD_FOLDER_BASE', '\\10.0.70.169\\share\\FOFANA')
        
        # Configuration des magasins
        self.shop_config = load_shop_config(os.path.dirname(self.base_dir))
        self.shop_codes = list(self.shop_config.keys())
        
        # Configuration des dates (hier -> aujourd'hui par défaut)
        self.setup_dates()
        
        # Configuration du logging sera faite dans setup_logging()
        self.setup_logging()
        
        # Configuration de la session
        self.session = requests.Session()
        self.session.auth = (self.username, self.password)
        self.session.verify = False
        
        print(f"Extracteur API Commandes initialisé pour {self.username}")
        print(f"Magasins configurés: {self.shop_codes}")
        print(f"Période: {self.start_date.strftime('%Y-%m-%d')} à {self.end_date.strftime('%Y-%m-%d')}")
        if self.status_filter:
            print(f"Filtre de statut: {self.status_filter}")

    def setup_logging(self):
        """Configure le système de logging"""
        # Créer le dossier de logs sur le réseau
        log_network_path = self.get_log_network_path()
        if log_network_path:
            log_file = os.path.join(log_network_path, f'api_commande_{datetime.now().strftime("%Y%m%d")}.log')
        else:
            # Fallback local
            log_file = os.path.join(self.base_dir, f'api_commande_{datetime.now().strftime("%Y%m%d")}.log')
        
        # Configuration du logging
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(levelname)s - %(message)s',
            handlers=[
                logging.FileHandler(log_file, encoding='utf-8'),
                SafeStreamHandler()
            ]
        )
        
        # Définir les permissions pour permettre à tous les utilisateurs d'écrire
        from utils import set_log_file_permissions
        set_log_file_permissions(log_file)
        
        global logger
        logger = logging.getLogger(__name__)

    def setup_dates(self):
        """Configure les dates d'extraction"""
        # Vérifier si des dates personnalisées sont fournies via les variables d'environnement
        start_date_str = os.getenv('DATE_START')
        end_date_str = os.getenv('DATE_END')
        
        if start_date_str and end_date_str:
            try:
                # Parser les dates
                start_date_only = datetime.strptime(start_date_str, '%Y-%m-%d')
                end_date_only = datetime.strptime(end_date_str, '%Y-%m-%d')
                
                # Ajouter les heures appropriées
                self.start_date = start_date_only.replace(hour=0, minute=0, second=0, microsecond=0)
                self.end_date = end_date_only.replace(hour=23, minute=59, second=59, microsecond=999999)
                
                print(f"Dates personnalisées: {self.start_date.strftime('%Y-%m-%d %H:%M:%S')} à {self.end_date.strftime('%Y-%m-%d %H:%M:%S')}")
            except ValueError:
                print("Format de date invalide, utilisation des dates par défaut")
                self.setup_default_dates()
        else:
            # Utiliser les dates par défaut (hier -> aujourd'hui)
            self.setup_default_dates()
    
    def setup_default_dates(self):
        """Configure les dates par défaut (hier -> aujourd'hui)"""
        today = datetime.now()
        yesterday = today - timedelta(days=1)
        
        # Ajouter les heures appropriées
        self.start_date = yesterday.replace(hour=0, minute=0, second=0, microsecond=0)
        self.end_date = today.replace(hour=23, minute=59, second=59, microsecond=999999)
        
        print(f"Dates par défaut: {self.start_date.strftime('%Y-%m-%d %H:%M:%S')} à {self.end_date.strftime('%Y-%m-%d %H:%M:%S')}")

    def get_network_path_for_shop(self, shop_code):
        """Retourne le chemin réseau pour un magasin spécifique"""
        network_path = build_network_path(self.network_folder_base, "COMMANDE")
        if create_network_folder(network_path):
            return network_path
        return None
        
    def get_log_network_path(self):
        """Retourne le chemin réseau pour les logs"""
        if not self.network_folder_base:
            return None
        # Chemin: \\10.0.70.169\share\FOFANA\Etats Natacha\SCRIPT\LOG
        base = self.network_folder_base.replace('/', '\\')
        if base.endswith('\\'):
            base = base[:-1]
        log_path = f"{base}\\Etats Natacha\\SCRIPT\\LOG"
        if create_network_folder(log_path):
            return log_path
        return None

    def test_api_connection(self, base_url):
        """Teste la connexion à l'API"""
        try:
            test_url = f"{base_url}/api/user/"
            response = self.session.get(test_url, timeout=10)
            if response.status_code == 200:
                logger.info(f"✅ Connexion API réussie: {base_url}")
                return True
            else:
                logger.error(f"❌ Erreur de connexion API {base_url}: {response.status_code} {response.text}")
                return False
        except Exception as e:
            logger.error(f"❌ Erreur de connexion API {base_url}: {e}")
            return False

    def get_shop_info(self, base_url, shop_code):
        """Récupère les informations d'un magasin"""
        try:
            # Essayer d'abord avec l'endpoint direct
            url = f"{base_url}/api/shop/{shop_code}/"
            response = self.session.get(url, timeout=30)
            
            if response.status_code == 200:
                shop_data = response.json()
                if isinstance(shop_data, dict) and shop_data.get('reference') == shop_code:
                    logger.info(f"✅ Magasin {shop_code} trouvé: {shop_data.get('name', 'Nom inconnu')}")
                    return shop_data
            
            # Si pas trouvé, chercher dans la liste paginée
            url = f"{base_url}/api/shop/"
            page = 1
            while True:
                params = {'page': page, 'page_size': 100}
                response = self.session.get(url, params=params, timeout=30)
                
                if response.status_code == 200:
                    data = response.json()
                    shops = data.get('results', [])
                    
                    for shop in shops:
                        if shop.get('reference') == shop_code:
                            logger.info(f"✅ Magasin {shop_code} trouvé: {shop.get('name', 'Nom inconnu')}")
                            return shop
                    
                    if not data.get('next'):
                        break
                    page += 1
                else:
                    break
            
            logger.warning(f"⚠️ Magasin {shop_code} non trouvé dans la liste")
            return None
            
        except Exception as e:
            logger.error(f"❌ Erreur lors de la récupération des informations du magasin: {e}")
            return None

    def count_total_records(self, base_url, shop_id, page_size=1000):
        """Compte le nombre total de commandes disponibles"""
        try:
            url = f"{base_url}/api/supplier_order/"
            params = {
                'shop': shop_id,
                'page_size': page_size,
                'page': 1,
                'date_0': self.start_date.strftime('%Y-%m-%dT00:00:00'),
                'date_1': self.end_date.strftime('%Y-%m-%dT23:59:59'),
                'is_deleted': 'false'
            }
            
            # Ajouter le filtre de statut si spécifié
            if self.status_filter and self.status_filter.lower() == 'en attente de livraison':
                params['is_awaiting_delivery'] = 'true'
            
            response = self.session.get(url, params=params, timeout=30)
            
            if response.status_code == 200:
                data = response.json()
                total_count = data.get('count', 0)
                return total_count
            else:
                logger.error(f"❌ Erreur lors du comptage: {response.status_code}")
                return 0
                
        except Exception as e:
            logger.error(f"❌ Erreur lors du comptage: {e}")
            return 0

    def get_orders(self, base_url, shop_id, page_size=1000):
        """Récupère les commandes avec pagination complète"""
        # D'abord, compter le nombre total de commandes
        logger.info("🔍 Comptage du nombre total de commandes...")
        total_records = self.count_total_records(base_url, shop_id, page_size)
        
        if total_records == 0:
            logger.warning("⚠️ Aucune commande trouvée")
            return []
        
        # Afficher le cadre avec le nombre total
        logger.info("=" * 60)
        logger.info(f"📊 INFORMATIONS D'EXTRACTION - MAGASIN {shop_id}")
        logger.info("=" * 60)
        logger.info(f"📊 Total commandes disponibles: {total_records:,}")
        logger.info(f"📅 Période: {self.start_date.strftime('%Y-%m-%d %H:%M:%S')} à {self.end_date.strftime('%Y-%m-%d %H:%M:%S')}")
        logger.info(f"🏪 Magasin: {shop_id}")
        logger.info("=" * 60)
        
        try:
            url = f"{base_url}/api/supplier_order/"
            params = {
                'shop': shop_id,
                'page_size': page_size,
                'date_0': self.start_date.strftime('%Y-%m-%dT00:00:00'),
                'date_1': self.end_date.strftime('%Y-%m-%dT23:59:59'),
                'is_deleted': 'false'
            }
            
            # Ajouter le filtre de statut si spécifié
            if self.status_filter:
                if self.status_filter.lower() == 'en attente de livraison':
                    params['is_awaiting_delivery'] = 'true'
                    logger.info(f"Filtre API: is_awaiting_delivery=true")
                else:
                    logger.info(f"Filtre de statut: '{self.status_filter}' (filtrage post-récupération)")
            else:
                logger.info("Aucun filtre de statut - récupération de toutes les commandes")
            
            all_orders = []
            page = 1
            total_pages = (total_records + page_size - 1) // page_size
            
            while page <= total_pages:
                # Afficher la progression
                progress_percent = (page - 1) * 100 // total_pages if total_pages > 0 else 0
                logger.info(f"📄 Récupération page {page}/{total_pages} ({progress_percent}%) - {len(all_orders):,}/{total_records:,} commandes...")
                
                params['page'] = page
                
                response = self.session.get(url, params=params, timeout=60)
                response.raise_for_status()
                data = response.json()
                
                orders_on_page = data.get('results', [])
                all_orders.extend(orders_on_page)
                
                logger.info(f"  ✅ Page {page}: {len(orders_on_page)} commandes récupérées (total: {len(all_orders):,}/{total_records:,})")
                
                # Vérifier s'il y a une page suivante
                if not data.get('next'):
                    logger.info(f"  ✅ Dernière page atteinte (page {page})")
                    break
                
                page += 1
            
            # Filtrage post-récupération si nécessaire
            if self.status_filter and self.status_filter.lower() != 'en attente de livraison':
                logger.info(f"Filtrage post-récupération pour le statut: '{self.status_filter}'")
                original_count = len(all_orders)
                all_orders = [order for order in all_orders 
                            if order.get('status', '').lower() == self.status_filter.lower()]
                filtered_count = len(all_orders)
                logger.info(f"Filtrage: {original_count} -> {filtered_count} commandes")
            
            # Afficher le résumé final
            logger.info("=" * 60)
            logger.info(f"✅ RÉSUMÉ EXTRACTION - MAGASIN {shop_id}")
            logger.info("=" * 60)
            logger.info(f"📊 Commandes trouvées: {total_records:,}")
            logger.info(f"📥 Commandes extraites: {len(all_orders):,}")
            logger.info(f"📈 Taux de réussite: {(len(all_orders)/total_records*100):.1f}%" if total_records > 0 else "📈 Taux de réussite: 0%")
            logger.info("=" * 60)
            
            logger.info(f"✅ {len(all_orders)} commandes récupérées au total")
            return all_orders
            
        except Exception as e:
            logger.error(f"❌ Erreur lors de la récupération des commandes: {e}")
            return []

    def export_to_csv(self, orders, shop_code, shop_name):
        """Exporte les commandes vers un fichier CSV"""
        if not orders:
            logger.warning(f"Aucune commande à exporter pour le magasin {shop_code}")
            return None
        
        # Créer le dossier réseau
        network_path = self.get_network_path_for_shop(shop_code)
        if not network_path:
            logger.error(f"Impossible de créer le dossier réseau pour le magasin {shop_code}")
            return None
        
        # Créer un fichier temporaire local
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f'export_commande_{shop_code}_{timestamp}.csv'
        local_filepath = os.path.join(self.base_dir, filename)
        
        # En-têtes CSV basés sur les champs disponibles (inclut la date de commande)
        fieldnames = [
            'id',
            'reference',
            'status',
            'supplier',
            'shop',
            'order_date',            # date (date de commande)
            'delivery_date',         # date de livraison
            'validation_date',       # si disponible
            'created_at',
            'updated_at',
            'total_amount',
            'is_direct',
            'is_external',
            'is_deleted',
            'notes',
            'shop_code',
            'shop_name'
        ]
        
        try:
            # Créer le fichier CSV local
            # utf-8-sig pour compat Excel (accents)
            with open(local_filepath, 'w', newline='', encoding='utf-8-sig') as csvfile:
                writer = csv.DictWriter(csvfile, fieldnames=fieldnames, delimiter=';')
                writer.writeheader()
                
                for order in orders:
                    # Préparer les données pour l'export
                    row = {
                        'id': order.get('id', ''),
                        'reference': order.get('reference', ''),
                        'status': order.get('status', ''),
                        'supplier': order.get('supplier', {}).get('name', '') if isinstance(order.get('supplier'), dict) else '',
                        'shop': order.get('shop', {}).get('name', '') if isinstance(order.get('shop'), dict) else '',
                        'order_date': order.get('date', ''),
                        'delivery_date': order.get('delivery_date', ''),
                        'validation_date': order.get('validation_date', ''),
                        'created_at': order.get('created_at', ''),
                        'updated_at': order.get('updated_at', ''),
                        'total_amount': order.get('total_amount', ''),
                        'is_direct': order.get('is_direct', ''),
                        'is_external': order.get('is_external', ''),
                        'is_deleted': order.get('is_deleted', ''),
                        'notes': order.get('notes', ''),
                        'shop_code': shop_code,
                        'shop_name': shop_name
                    }
                    writer.writerow(row)
            
            logger.info(f"✅ Fichier CSV créé localement: {local_filepath}")
            logger.info(f"   {len(orders)} commandes exportées")
            logger.info(f"   {len(fieldnames)} colonnes par commande")
            
            # Copier vers le réseau et supprimer le fichier local
            network_filepath = os.path.join(network_path, filename)
            shutil.copy2(local_filepath, network_filepath)
            logger.info(f"✅ Fichier copié sur le réseau: {network_filepath}")
            
            # Supprimer le fichier local
            os.remove(local_filepath)
            logger.info(f"🗑️ Fichier local supprimé")
            
            return network_filepath
            
        except Exception as e:
            logger.error(f"❌ Erreur lors de l'export CSV: {e}")
            return None

    def extract_shop(self, shop_code):
        """Extrait les commandes pour un magasin spécifique"""
        shop_info = self.shop_config.get(shop_code)
        if not shop_info:
            logger.error(f"Configuration manquante pour le magasin {shop_code}")
            return False
        
        base_url = shop_info['url']
        shop_name = shop_info['name']
        
        logger.info(f"==================================================")
        logger.info(f"EXTRACTION COMMANDES MAGASIN {shop_code}")
        logger.info(f"==================================================")
        logger.info(f"URL serveur: {base_url}")
        logger.info(f"Nom magasin: {shop_name}")
        
        # Test de connexion
        if not self.test_api_connection(base_url):
            logger.error(f"❌ Impossible de se connecter au serveur {base_url}")
            return False
        
        # Récupérer les informations du magasin
        logger.info(f"Récupération des informations du magasin {shop_code}...")
        shop_data = self.get_shop_info(base_url, shop_code)
        if not shop_data:
            logger.error(f"❌ Impossible de récupérer les informations du magasin {shop_code}")
            return False
        
        shop_id = shop_data.get('id')
        if not shop_id:
            logger.error(f"❌ ID du magasin non trouvé")
            return False
        
        # Récupérer les commandes
        logger.info(f"Récupération des commandes pour le magasin {shop_code}...")
        orders = self.get_orders(base_url, shop_id)
        
        if not orders:
            logger.warning(f"⚠️ Aucune commande trouvée pour le magasin {shop_code}")
            return True
        
        logger.info(f"✅ {len(orders)} commandes récupérées au total pour le magasin {shop_code}")
        
        # Exporter vers CSV
        logger.info("=" * 60)
        logger.info(f"💾 EXPORT CSV - MAGASIN {shop_code}")
        logger.info("=" * 60)
        csv_file = self.export_to_csv(orders, shop_code, shop_name)
        if csv_file:
            logger.info("=" * 60)
            logger.info(f"✅ MAGASIN {shop_code} TRAITÉ AVEC SUCCÈS")
            logger.info("=" * 60)
            logger.info(f"📁 Fichier sur le réseau: {csv_file}")
            logger.info(f"📊 Lignes exportées: {len(orders):,}")
            logger.info("=" * 60)
            return True
        else:
            logger.error(f"❌ Erreur lors de l'export pour le magasin {shop_code}")
            return False

    def extract_all(self):
        """Extrait les commandes pour tous les magasins configurés"""
        logger.info("=" * 60)
        logger.info("DÉBUT DE L'EXTRACTION API PROSUMA - COMMANDES")
        logger.info("=" * 60)
        
        # Créer le dossier réseau au début
        network_path = self.get_network_path_for_shop("COMMANDE")
        if network_path:
            logger.info(f"✅ Dossier réseau créé: {network_path}")
        else:
            logger.warning("⚠️ Impossible de créer le dossier réseau")
        
        successful_shops = 0
        total_shops = len(self.shop_codes)
        failed_shops = []  # Liste des magasins en échec avec leur nom
        
        for shop_code in self.shop_codes:
            try:
                logger.info(f"\n{'='*60}")
                logger.info(f"TRAITEMENT MAGASIN {shop_code}")
                logger.info(f"{'='*60}")
                
                if self.extract_shop(shop_code):
                    successful_shops += 1
                    logger.info(f"✅ Magasin {shop_code} traité avec succès")
                else:
                    # Extraction échouée
                    shop_name = self.shop_config.get(shop_code, {}).get('name', 'Nom inconnu')
                    failed_shops.append((shop_code, shop_name))
                    logger.error(f"❌ Erreur lors de l'extraction du magasin {shop_code}")
                    
            except Exception as e:
                # Erreur lors de l'extraction
                shop_name = self.shop_config.get(shop_code, {}).get('name', 'Nom inconnu')
                failed_shops.append((shop_code, shop_name))
                logger.error(f"❌ Erreur lors de l'extraction du magasin {shop_code}: {e}")
        
        # Résumé final
        logger.info(f"\n{'='*60}")
        logger.info("📊📊📊 RÉSUMÉ FINAL DE L'EXTRACTION 📊📊📊")
        logger.info(f"{'='*60}")
        logger.info(f"✅ Magasins traités avec succès: {successful_shops}/{total_shops}")
        logger.info(f"❌ Magasins en échec: {len(failed_shops)}/{total_shops}")
        
        # Afficher les magasins en erreur s'il y en a
        if failed_shops:
            logger.warning("=" * 60)
            logger.warning("⚠️⚠️⚠️ EXTRACTION PARTIELLEMENT RÉUSSIE ⚠️⚠️⚠️")
            logger.warning("=" * 60)
            logger.warning("")
            logger.warning("📋📋📋 LISTE DES MAGASINS EN ÉCHEC 📋📋📋")
            logger.warning("=" * 60)
            for shop_code, shop_name in failed_shops:
                logger.warning(f"   ❌ Code magasin: {shop_code} - Nom: {shop_name}")
            logger.warning("=" * 60)
            logger.warning("")
        elif successful_shops == total_shops:
            logger.info("=" * 60)
            logger.info("✅✅✅ EXTRACTION COMPLÈTEMENT RÉUSSIE ✅✅✅")
            logger.info("=" * 60)
        else:
            logger.error("=" * 60)
            logger.error("❌❌❌ AUCUNE EXTRACTION RÉUSSIE ❌❌❌")
            logger.error("=" * 60)
        
        if successful_shops == total_shops:
            logger.info("✅ Extraction complètement réussie")
        elif successful_shops > 0:
            logger.warning("⚠️ Extraction partiellement réussie")
        else:
            logger.error("❌ Aucune extraction réussie")

def main():
    """Fonction principale"""
    try:
        extractor = ProsumaAPICommandeExtractor()
        extractor.extract_all()
    except Exception as e:
        print(f"❌ Erreur fatale: {e}")

if __name__ == "__main__":
    main()
