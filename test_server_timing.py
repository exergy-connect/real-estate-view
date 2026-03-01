#!/usr/bin/env python3
"""
Test script to retrieve API endpoint and display Server-Timing headers.
Repeats the request 3 times with 1 second delay between requests.
"""

import requests
import time
from typing import Optional

def get_server_timing(url: str) -> Optional[str]:
    """Fetch the URL and return the Server-Timing header value."""
    try:
        response = requests.get(url)
        response.raise_for_status()
        return response.headers.get('Server-Timing', None)
    except requests.RequestException as e:
        print(f"Error fetching {url}: {e}")
        return None

def main():
    url = "https://real-estate-view.jvb127.workers.dev/api/entity?id=fault_system_Clinton_Fault"
    
    print(f"Testing Server-Timing headers for: {url}\n")
    print("=" * 80)
    
    for i in range(3):
        print(f"\nRequest #{i + 1}:")
        print("-" * 80)
        
        server_timing = get_server_timing(url)
        
        if server_timing:
            print(f"Server-Timing: {server_timing}")
            
            # Parse and display individual metrics
            metrics = server_timing.split(', ')
            for metric in metrics:
                print(f"  - {metric}")
        else:
            print("No Server-Timing header found")
        
        # Wait 1 second before next request (except after the last one)
        if i < 2:
            time.sleep(1)
    
    print("\n" + "=" * 80)
    print("Test complete")

if __name__ == "__main__":
    main()
