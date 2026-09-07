#!/usr/bin/env python3
"""
Génère une proposition de commande hebdomadaire pour le magasin 050 (CASH CENTER ZONE 4).

Principe (cf. readme.md, section 7) :
    quantité à commander = besoin prévisionnel + stock cible - stock disponible - stock déjà commandé

Entrée : pareto_050.csv (sortie de pareto_analysis.py), articles avec is_priority_80=True
Sortie : proposition_050.csv
"""

import csv
import json
import math
import os

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_URL = "https://pos1-prod-prosuma.prosuma.pos"
SHOP_050_ID = "de534d99-24e8-4bbc-a2da-fa78a697276b"

PARETO_CSV = "pareto_050.csv"
OUTPUT_CSV = "proposition_050.csv"

# Stock de sécurité exprimé en fraction de la vente hebdomadaire moyenne (ex: 0.5 = demi-semaine de sécurité)
SAFETY_STOCK_RATIO = 0.5


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


def load_priority_articles(path):
    articles = []
    with open(path, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f, delimiter=";")
        for row in reader:
            if row["is_priority_80"] == "True":
                articles.append(row)
    return articles


def fetch_product(session, ean):
    """Récupère les infos produit (stock, unité de commande, commandable) pour un EAN sur le magasin 050."""
    url = f"{BASE_URL}/api/product/"
    resp = session.get(url, params={"shop": SHOP_050_ID, "ean": ean}, timeout=20)
    if resp.status_code != 200:
        return None
    results = resp.json().get("results", [])
    return results[0] if results else None


def compute_quantity_to_order(avg_weekly_sales, stock, ordered_qty, ordering_unit):
    """Applique la formule du besoin prévisionnel avec arrondi à l'unité de commande."""
    safety_stock = avg_weekly_sales * SAFETY_STOCK_RATIO
    raw_need = avg_weekly_sales + safety_stock - stock - ordered_qty

    if raw_need <= 0:
        return 0.0

    ordering_unit = ordering_unit or 1.0
    nb_units = math.ceil(raw_need / ordering_unit)
    return nb_units * ordering_unit


def main():
    env = load_env(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
    session = requests.Session()
    session.auth = (env["USER"], env["PASSWORD"])
    session.verify = False

    priority_articles = load_priority_articles(PARETO_CSV)
    limit = int(os.environ.get("PROPOSAL_LIMIT", "0"))
    if limit:
        priority_articles = priority_articles[:limit]
    print(f"{len(priority_articles)} articles prioritaires (80% du CA) à analyser...")

    proposals = []
    skipped_not_orderable = []
    skipped_not_found = []
    skipped_negative_stock = []

    for i, art in enumerate(priority_articles, 1):
        ean = art["code"]

        # Ignorer les codes non-EAN (départements génériques type D10130999999)
        if not ean.isdigit():
            continue

        if i % 200 == 0:
            print(f"  ... {i}/{len(priority_articles)}")

        product = fetch_product(session, ean)
        if not product:
            skipped_not_found.append(ean)
            continue

        if not product.get("orderable", False):
            skipped_not_orderable.append(ean)
            continue

        stock = float(product.get("stock") or 0)
        ordered_qty = float(product.get("current_ordered_quantity") or 0)
        ordering_unit = float(product.get("ordering_unit") or 1)
        avg_weekly_sales = float(art["avg_weekly_quantity"])

        if stock < 0:
            # Stock non fiable (anomalie de suivi) : l'article reste prioritaire (80% du CA),
            # on couvre le besoin uniquement sur la base des ventes réelles, sans stock à déduire.
            skipped_negative_stock.append(ean)
            stock = 0.0

        qty_to_order = compute_quantity_to_order(avg_weekly_sales, stock, ordered_qty, ordering_unit)

        if qty_to_order <= 0:
            continue

        proposals.append({
            "ean": ean,
            "label": art["label"],
            "department": art["department"],
            "avg_weekly_sales": avg_weekly_sales,
            "stock": stock,
            "current_ordered_quantity": ordered_qty,
            "ordering_unit": ordering_unit,
            "quantity_proposed": qty_to_order,
            "product_id": product["id"],
        })

    proposals.sort(key=lambda p: p["avg_weekly_sales"], reverse=True)

    print()
    print(f"Propositions générées : {len(proposals)}")
    print(f"Articles non trouvés dans l'API : {len(skipped_not_found)}")
    print(f"Articles non commandables (orderable=False) : {len(skipped_not_orderable)}")
    print(f"Articles à stock négatif (anomalie) : {len(skipped_negative_stock)}")
    print()
    print("Aperçu (top 15) :")
    print(f"{'EAN':<15} {'Libellé':<35} {'Vte/sem':>9} {'Stock':>9} {'Qté prop.':>10}")
    for p in proposals[:15]:
        print(f"{p['ean']:<15} {p['label'][:35]:<35} {p['avg_weekly_sales']:>9.1f} {p['stock']:>9.1f} {p['quantity_proposed']:>10.1f}")

    fieldnames = [
        "ean", "label", "department", "avg_weekly_sales", "stock",
        "current_ordered_quantity", "ordering_unit", "quantity_proposed", "product_id",
    ]
    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=";")
        writer.writeheader()
        writer.writerows(proposals)

    print(f"\nProposition complète exportée dans {OUTPUT_CSV}")

    if skipped_not_orderable:
        with open("skipped_not_orderable_050.txt", "w") as f:
            f.write("\n".join(skipped_not_orderable))
    if skipped_not_found:
        with open("skipped_not_found_050.txt", "w") as f:
            f.write("\n".join(skipped_not_found))


if __name__ == "__main__":
    main()
