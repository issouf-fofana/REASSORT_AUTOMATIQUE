#!/usr/bin/env python3
"""
Analyse Pareto 20/80 des ventes du magasin 050 (CASH CENTER ZONE 4).
Lit le CSV d'export RPOS des lignes de vente, calcule le CA cumulé par article
et identifie les articles représentant ~80% du chiffre d'affaires.
"""

import csv
import sys
from collections import defaultdict

CSV_PATH = "050_statvente-lignes_articles_01062024_0000.csv"
OUTPUT_CSV = "pareto_050.csv"


def to_float(value):
    """Convertit '2 250' ou '-1 818' (format FR avec espaces) en float."""
    if not value:
        return 0.0
    return float(value.replace(" ", "").replace("\xa0", "").replace(",", "."))


def article_key(row):
    """Clé article: EAN si présent, sinon EAN saisi, sinon département."""
    ean = row["EAN"].strip()
    if ean:
        return ean
    ean_saisi = row["EAN saisi"].strip()
    if ean_saisi:
        return ean_saisi
    return row["code département"].strip()


def main():
    stats = defaultdict(lambda: {
        "label": "",
        "department": "",
        "ca_ht": 0.0,
        "ca_ttc": 0.0,
        "quantity": 0.0,
        "nb_lines": 0,
        "dates": set(),
    })

    with open(CSV_PATH, encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter=";")
        for row in reader:
            key = article_key(row)
            s = stats[key]
            s["label"] = row["Libellé produit"].strip() or s["label"]
            s["department"] = row["nom département"].strip() or s["department"]
            s["ca_ht"] += to_float(row["CA H.T."])
            s["ca_ttc"] += to_float(row["CA T.T.C."])
            s["quantity"] += to_float(row["quantité vendue"])
            s["nb_lines"] += 1
            s["dates"].add(row["date"][:10])

    # Nombre de semaines couvertes par les données (pour la vente moyenne hebdo)
    all_dates = set()
    for s in stats.values():
        all_dates |= s["dates"]
    min_date, max_date = min(all_dates), max(all_dates)
    from datetime import date
    d0 = date.fromisoformat(min_date)
    d1 = date.fromisoformat(max_date)
    nb_weeks = max(1, (d1 - d0).days / 7)

    # Ne garder que les articles à CA positif (retours/annulations nets exclus)
    articles = [
        {
            "code": key,
            "label": s["label"],
            "department": s["department"],
            "ca_ht": round(s["ca_ht"], 2),
            "ca_ttc": round(s["ca_ttc"], 2),
            "quantity": round(s["quantity"], 3),
            "nb_lines": s["nb_lines"],
            "avg_weekly_quantity": round(s["quantity"] / nb_weeks, 3),
        }
        for key, s in stats.items()
        if s["ca_ht"] > 0
    ]

    articles.sort(key=lambda a: a["ca_ht"], reverse=True)

    total_ca = sum(a["ca_ht"] for a in articles)
    cumulative = 0.0
    for a in articles:
        cumulative += a["ca_ht"]
        a["cumulative_pct"] = round(cumulative / total_ca * 100, 2) if total_ca else 0
        a["is_priority_80"] = a["cumulative_pct"] <= 80.0

    nb_priority = sum(1 for a in articles if a["is_priority_80"])
    # Inclure le premier article qui dépasse 80% (frontière incluse pour ne pas couper artificiellement)
    if nb_priority < len(articles):
        articles[nb_priority]["is_priority_80"] = True
        nb_priority += 1

    print(f"Période analysée : {min_date} -> {max_date} ({nb_weeks:.1f} semaines)")
    print(f"Nombre d'articles avec CA positif : {len(articles)}")
    print(f"CA total (H.T.) : {total_ca:,.0f} CFA")
    print(f"Articles représentant ~80% du CA : {nb_priority} ({nb_priority/len(articles)*100:.1f}% de l'assortiment)")
    print()
    print("Top 15 articles par CA :")
    print(f"{'Code':<15} {'Libellé':<40} {'CA HT':>12} {'%cumul':>8} {'Qte/sem':>9}")
    for a in articles[:15]:
        print(f"{a['code']:<15} {a['label'][:40]:<40} {a['ca_ht']:>12,.0f} {a['cumulative_pct']:>7.2f}% {a['avg_weekly_quantity']:>9.2f}")

    fieldnames = [
        "code", "label", "department", "ca_ht", "ca_ttc", "quantity",
        "avg_weekly_quantity", "nb_lines", "cumulative_pct", "is_priority_80",
    ]
    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=";")
        writer.writeheader()
        writer.writerows(articles)

    print(f"\nRésultat complet exporté dans {OUTPUT_CSV}")


if __name__ == "__main__":
    main()
