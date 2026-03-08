# Face Wellness Pillar Logic (Compact)

Use this as the core logic brief for an LLM.

## 1) User-Facing Output (what should be shown)

For each of these 6 pillars, return:
- `score` (0-100, higher is better)
- `state` (bucket label from thresholds)
- `driver_region` (most affected region)
- `evidence_signals` (metrics used)
- `insight` (short explanation)

### Pillars and states

1. `Oil_Balance`
- Fresh & Balanced
- Slightly Oily
- Oil-Prone
- Very Oily
- Shine & Congestion Heavy

2. `Breakouts_Skin_Calmness`
- Clear & Calm
- Occasional Pimples
- Flare-Prone
- Frequent Breakouts
- Highly Reactive

3. `Evenness_Marks`
- Even & Bright
- Mild Marks
- Uneven Tone
- Stubborn Dark Spots
- Heavy Mark Memory

4. `Skin_Strength_Sensitivity`
- Strong & Resilient
- Slightly Sensitive
- Easily Irritated
- Weak & Reactive
- Highly Sensitive

5. `Smoothness_Pore_Look`
- Smooth & Refined
- Mild Texture
- Visible Pores
- Rough & Uneven
- Deep Texture Concerns

6. `Firmness_Fine_Lines`
- Firm & Youthful
- Early Fine Lines
- Mild Firmness Drop
- Visible Aging Signs
- Advanced Firmness Loss

### Pillar thresholds (for state)

- `Oil_Balance`: [75, 55, 35, 15]
- `Breakouts_Skin_Calmness`: [80, 60, 40, 20]
- `Evenness_Marks`: [80, 60, 40, 20]
- `Skin_Strength_Sensitivity`: [75, 55, 35, 15]
- `Smoothness_Pore_Look`: [75, 55, 35, 15]
- `Firmness_Fine_Lines`: [80, 60, 40, 20]

Also return:
- `demographics` (age, gender)
- `dermatology_summary`:
  - `primary_finding`:
    - add `Active Inflammation` if Breakouts score < 50
    - add `Sebum Dysregulation` if Oil score < 50
    - add `Barrier Compromise` if Skin Strength score < 50
    - else `Maintenance & Prevention`
  - `clinical_standard`: `{age}yo {gender} Profile`
  - `professional_grade`: `Dermatology-Aligned Assessment`
- `confidence` (overall input-data completeness confidence)

## 2) Variables Used + Relation to 6 Pillars

Input context:
- `global.age`, `global.gender`, `global.environment_type`
- `regions.{region_name}.{metric_name}`
- regions typically include: `forehead`, `nose`, `chin`, `left_cheek`, `right_cheek`, `jawline`

Scoring backbone:
- For each pillar-model:
  - compute region risk from weighted metrics
  - combine region risks by region weights
  - apply demographic factor
  - convert to final score: `100 - clamp(risk * factor, 0..1) * 100`

### Pillar -> metrics + key regions

`Oil_Balance`:
- metrics: `gloss_reflectance_score`, `pore_diameter_variance`, `comedone_density`
- strong regions: nose, forehead, chin

`Breakouts_Skin_Calmness`:
- metrics: `papule_density`, `pustule_density`, `nodule_probability`, `erythema_index`
- strong regions: jawline, forehead, cheeks

`Evenness_Marks`:
- metrics: `pih_density`, `hyperpigmented_lesion_count`, `melanin_variance_score`, `tone_asymmetry_score`
- strong regions: cheeks, forehead

`Skin_Strength_Sensitivity`:
- metrics: `hydration_proxy` (inverted as `1-hydration_proxy`), `micro_scaling_density`, `erythema_index`
- strong regions: cheeks, forehead, chin

`Smoothness_Pore_Look`:
- metrics: `texture_variance`, `pore_diameter_variance`, `fine_line_density`
- strong regions: cheeks, nose, forehead

`Firmness_Fine_Lines`:
- metrics: `wrinkle_depth_index`, `sagging_index`, `elasticity_proxy` (inverted as `1-elasticity_proxy`)
- strong regions: forehead, jawline, cheeks

### Demographic/environment effects

- age/gender adjust severity factors per model (oil/acne/pigment/barrier/aging)
- if `environment_type == urban`, forehead and nose region influence is slightly boosted
