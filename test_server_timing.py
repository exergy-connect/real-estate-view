#!/usr/bin/env python3
"""
Test script to retrieve API endpoint and display Server-Timing headers.
Repeats the request 3 times with 1 second delay between requests.
"""

import requests
import time
from typing import Optional

def get_server_timing(url: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Fetch the URL and return the Server-Timing header value, X-Cache-Level header, and response body."""
    try:
        response = requests.get(url)
        response.raise_for_status()
        server_timing = response.headers.get('Server-Timing', None)
        cache_level = response.headers.get('X-Cache-Level', None)
        body = response.text
        return server_timing, cache_level, body
    except requests.RequestException as e:
        print(f"Error fetching {url}: {e}")
        return None, None, None

def parse_metrics(server_timing: str) -> dict:
    """Parse Server-Timing header into a dictionary."""
    metrics = {}
    if server_timing:
        for metric in server_timing.split(', '):
            # Handle dur= metrics (io, cpu)
            if ';dur=' in metric:
                parts = metric.split(';dur=')
                if len(parts) == 2:
                    metrics[parts[0]] = float(parts[1])
            # Handle desc= metrics (cache)
            elif ';desc=' in metric:
                parts = metric.split(';desc=')
                if len(parts) == 2:
                    metrics[parts[0]] = parts[1]
    return metrics

def test_endpoint(url: str, endpoint_name: str):
    """Test an endpoint 3 times with 1 second delay."""
    print(f"\n{'=' * 80}")
    print(f"Testing {endpoint_name}: {url}")
    print("=" * 80)
    
    results = []
    
    for i in range(3):
        print(f"\nRequest #{i + 1}:")
        print("-" * 80)
        
        server_timing, cache_level, body = get_server_timing(url)
        
        if server_timing:
            print(f"Server-Timing: {server_timing}")
            metrics = parse_metrics(server_timing)
            
            # Parse and display individual metrics
            for metric_name, value in metrics.items():
                if metric_name == 'cache':
                    print(f"  - {metric_name}: level {value}")
                else:
                    print(f"  - {metric_name}: {value:.2f}ms")
            
            # Get cache level from header or Server-Timing
            cache_level_value = cache_level if cache_level else metrics.get('cache', 'N/A')
            
            results.append({
                'request': i + 1,
                'io': metrics.get('io', 0),
                'cpu': metrics.get('cpu', 0),
                'cache': cache_level_value,
                'total': metrics.get('io', 0) + metrics.get('cpu', 0)
            })
            
            if cache_level:
                print(f"X-Cache-Level: {cache_level}")
        else:
            print("No Server-Timing header found")
            results.append({
                'request': i + 1,
                'io': 0,
                'cpu': 0,
                'cache': 'N/A',
                'total': 0
            })
        
        if body and endpoint_name == "/api/entity":
            print(f"\nResponse Body:")
            try:
                import json
                parsed = json.loads(body)
                print(json.dumps(parsed, indent=2))
            except json.JSONDecodeError:
                print(body)
        elif body and endpoint_name == "/api":
            try:
                import json
                parsed = json.loads(body)
                if isinstance(parsed, dict) and "data" in parsed:
                    print(f"\nResponse: {len(parsed.get('data', {}))} entity types")
            except:
                pass
        
        # Wait 1 second before next request (except after the last one)
        if i < 2:
            time.sleep(1)
    
    # Show pattern over time
    if results:
        print(f"\n{'=' * 80}")
        print("Performance Pattern Over Time:")
        print("-" * 80)
        print(f"{'Request':<10} {'I/O (ms)':<12} {'CPU (ms)':<12} {'Cache':<10} {'Total (ms)':<12}")
        print("-" * 80)
        for r in results:
            cache_str = str(r.get('cache', 'N/A'))
            print(f"{r['request']:<10} {r['io']:<12.2f} {r['cpu']:<12.2f} {cache_str:<10} {r['total']:<12.2f}")
        
        # Calculate trends
        if len(results) > 1:
            io_trend = results[-1]['io'] - results[0]['io']
            cpu_trend = results[-1]['cpu'] - results[0]['cpu']
            total_trend = results[-1]['total'] - results[0]['total']
            
            print("-" * 80)
            print(f"Trend (last - first):")
            print(f"  I/O:   {io_trend:+.2f}ms")
            print(f"  CPU:   {cpu_trend:+.2f}ms")
            print(f"  Total: {total_trend:+.2f}ms")
            
            # Show cache level progression
            cache_levels = [str(r.get('cache', 'N/A')) for r in results]
            if len(set(cache_levels)) > 1:
                print(f"  Cache: {cache_levels[0]} → {cache_levels[-1]}")
            
            # Show averages
            avg_io = sum(r['io'] for r in results) / len(results)
            avg_cpu = sum(r['cpu'] for r in results) / len(results)
            avg_total = sum(r['total'] for r in results) / len(results)
            
            print(f"\nAverages:")
            print(f"  I/O:   {avg_io:.2f}ms")
            print(f"  CPU:   {avg_cpu:.2f}ms")
            print(f"  Total: {avg_total:.2f}ms")
            
            # Cache level summary
            cache_counts = {}
            for r in results:
                cache = str(r.get('cache', 'N/A'))
                cache_counts[cache] = cache_counts.get(cache, 0) + 1
            print(f"  Cache levels: {', '.join(f'{k} ({v}x)' for k, v in cache_counts.items())}")

def main():
    base_url = "https://real-estate-view.jvb127.workers.dev"
    
    # Test /api/entity endpoint
    entity_url = f"{base_url}/api/entity?id=fault_system_Clinton_Fault"
    test_endpoint(entity_url, "/api/entity")
    
    # Test /api endpoint
    api_url = f"{base_url}/api"
    test_endpoint(api_url, "/api")
    
    print("\n" + "=" * 80)
    print("Test complete")

if __name__ == "__main__":
    main()
