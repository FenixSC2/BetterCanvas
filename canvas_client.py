import requests
from config import CANVAS_BASE_URL, HEADERS

# Generic Canvas GET request
def canvas_get(endpoint, params=None):
    url = f"{CANVAS_BASE_URL}/api/v1{endpoint}"
    r = requests.get(url, headers=HEADERS, params=params)

    if r.status_code != 200:
        raise Exception(f"Canvas API error {r.status_code}: {r.text}")

    return r.json()

# ----------------------------------
# Fetch All Courses with Pagination
# ----------------------------------
def get_courses():
    results = []
    # Hard-coding the URL for the Courses endpoint
    # This ensures brackets and multiple state parameters are sent exactly as needed
    url = (
        f"{CANVAS_BASE_URL}/api/v1/courses?"
        "include[]=term&include[]=enrollments&"
        "state[]=active&state[]=completed&state[]=concluded&state[]=available&"
        "per_page=100"
    )
    
    print("--- 🛰️  Starting 'Force-All' Course Fetch ---")

    while url:
        print(f"DEBUG: Requesting: {url}")
        response = requests.get(url, headers=HEADERS)
        
        if response.status_code != 200:
            print(f"❌ Canvas Error {response.status_code}: {response.text}")
            break

        data = response.json()
        results.extend(data)
        print(f"DEBUG: Received {len(data)} items. Total so far: {len(results)}")

        # Check for the next page link
        url = response.links.get("next", {}).get("url")
            
    return results

# TODO
# ----------------------------------
# Fetch Upcoming Assignments
# ----------------------------------
def get_upcoming_assignments():
    return canvas_get("/users/self/upcoming_events")

# TODO
# ----------------------------------
# Fetch Course Grades
# ----------------------------------
def get_course_grades(course_id: int):
    return canvas_get(f"/courses/{course_id}/enrollments")

