import json
import random
import numpy as np

# --- GEOGRAPHIC HUBS ---
RESIDENTIAL_SEEDS = {
    'North_Swords': {'lat': 53.4597, 'lng': -6.2181, 'weight': 0.25},
    'West_Lucan': {'lat': 53.3562, 'lng': -6.4063, 'weight': 0.20},
    'South_Tallaght': {'lat': 53.2878, 'lng': -6.3653, 'weight': 0.20},
    'South_Dundrum': {'lat': 53.2913, 'lng': -6.2459, 'weight': 0.15},
    'East_DunLaoghaire': {'lat': 53.2944, 'lng': -6.1339, 'weight': 0.10},
    'North_Whitehall': {'lat': 53.3841, 'lng': -6.2441, 'weight': 0.10}
}

DESTINATION_HUBS = {
    'City_Centre': [(53.3416, -6.2367), (53.3493, -6.2493)],  # IFSC/Docks
    'Local_Industrial': {
        'North_Swords': (53.4644, -6.2289),   # Airside Retail
        'West_Lucan': (53.3501, -6.4122),      # Liffey Valley
        'South_Tallaght': (53.2845, -6.3712)  # Square/Hospital
    },
    'Small_Business_Zones': [
        (53.3023, -6.2289),  # Blackrock Main St
        (53.3922, -6.3950),  # Blanchardstown Village
        (53.3522, -6.2280)   # Clontarf Local
    ]
}

def get_static_utc_bin(window_start_hour):
    """
    Returns a fixed 5-minute UTC departure time within a 2-hour window
    as an "HH:MM" string. Window covers window_start_hour to window_start_hour+1h55m.
    """
    random_minute = (random.randint(0, 115) // 5) * 5
    total_minutes = (window_start_hour * 60) + random_minute
    return f"{total_minutes // 60:02d}:{total_minutes % 60:02d}"

def get_jitter(coord, sigma=0.0035):
    """Gaussian jitter keeps users on real streets within their neighbourhood."""
    return {
        "lat": round(coord[0] + np.random.normal(0, sigma), 6),
        "lng": round(coord[1] + np.random.normal(0, sigma), 6)
    }

def generate_static_master_seed(total_users=1000):
    master_records = []
    res_names = list(RESIDENTIAL_SEEDS.keys())
    res_weights = [RESIDENTIAL_SEEDS[k]['weight'] for k in res_names]

    for i in range(1, total_users + 1):
        user_id = f"{i:04d}"
        home_key = np.random.choice(res_names, p=res_weights)
        home_coord = RESIDENTIAL_SEEDS[home_key]

        # --- PERSONA SELECTION (80% city, 15% local industrial, 5% small business) ---
        roll = random.random()
        if roll < 0.15:
            persona = "localIndustrial"
            work_coord = DESTINATION_HUBS['Local_Industrial'].get(
                home_key, DESTINATION_HUBS['City_Centre'][0]
            )
        elif roll < 0.20:
            persona = "smallBusinessNeighbourhood"
            work_coord = random.choice(DESTINATION_HUBS['Small_Business_Zones'])
        else:
            persona = "cityCentreRadial"
            work_coord = random.choice(DESTINATION_HUBS['City_Centre'])

        # --- FIXED JITTERED LOCATIONS (golden template -- stable across all collection days) ---
        h_loc = get_jitter((home_coord['lat'], home_coord['lng']))
        w_loc = get_jitter(work_coord)

        # Leg 1: Morning commute (07:00-08:55 UTC window, aligns with 07:00 EventBridge trigger)
        master_records.append({
            "runnerId":         f"{user_id}-L1",
            "userId":           user_id,
            "persona":          persona,
            "legType":          "morningCommute",
            "originLat":        h_loc["lat"],
            "originLng":        h_loc["lng"],
            "destLat":          w_loc["lat"],
            "destLng":          w_loc["lng"],
            "departureTimeUTC": get_static_utc_bin(7)
        })

        # Leg 2: Evening return (16:00-17:55 UTC window, aligns with 16:00 EventBridge trigger)
        master_records.append({
            "runnerId":         f"{user_id}-L2",
            "userId":           user_id,
            "persona":          persona,
            "legType":          "eveningReturn",
            "originLat":        w_loc["lat"],
            "originLng":        w_loc["lng"],
            "destLat":          h_loc["lat"],
            "destLng":          h_loc["lng"],
            "departureTimeUTC": get_static_utc_bin(16)
        })

    return master_records

if __name__ == "__main__":
    seed_data = generate_static_master_seed(1000)
    with open('dublin-static-master-seed.json', 'w') as f:
        json.dump(seed_data, f, indent=2)
    print(f"Generated {len(seed_data)} static-bin records.")
