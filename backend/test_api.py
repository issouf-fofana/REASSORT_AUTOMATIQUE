#!/usr/bin/env python3
"""
Script de test de connexion à l'API Rpos (Prosuma).
Teste product_line/ et bill/ (ventes) avec les identifiants du fichier .env.
"""

import os
import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


def load_env(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


BASE_URL = "https://pos1-prod-prosuma.prosuma.pos"

env = load_env(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
USERNAME = env["USER"]
PASSWORD = env["PASSWORD"]

session = requests.Session()
session.auth = (USERNAME, PASSWORD)
session.verify = False


def test_endpoint(path, params=None):
    url = f"{BASE_URL}{path}"
    print(f"\n--- GET {url} params={params} ---")
    try:
        resp = session.get(url, params=params, timeout=15)
        print("Status:", resp.status_code)
        if resp.status_code == 200:
            data = resp.json()
            count = data.get("count") if isinstance(data, dict) else None
            print("Count total:", count)
            results = data.get("results", data) if isinstance(data, dict) else data
            print("Extrait:", str(results)[:1000])
        else:
            print("Body:", resp.text[:1000])
    except Exception as e:
        print("Erreur:", e)


def list_shops():
    """Liste les magasins accessibles avec ces identifiants (comme le sélecteur du dashboard)."""
    url = f"{BASE_URL}/api/shop/"
    resp = session.get(url, params={"page_size": 100, "fields": "id,reference,name"}, timeout=15)
    resp.raise_for_status()
    return resp.json().get("results", [])


if __name__ == "__main__":
    print(f"Test de connexion API Rpos avec l'utilisateur {USERNAME}")
    test_endpoint("/api/user/")

    shops = list_shops()
    print(f"\n--- Magasins accessibles ({len(shops)}) ---")
    for shop in shops:
        print(f"  {shop['reference']} - {shop['name']} (id={shop['id']})")

    # Exemple: ventes (bill) filtrées par magasin
    for shop in shops:
        test_endpoint("/api/bill/", params={"shop": shop["id"], "page_size": 5})
