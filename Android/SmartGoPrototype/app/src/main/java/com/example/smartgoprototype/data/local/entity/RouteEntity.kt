package com.example.smartgoprototype.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Room entity for persisting routes locally.
 *
 * [activeDaysJson] stores the active days as a comma-separated string of 3-letter day codes
 * "MON,TUE,FRI..."
 * [cachedAt] is the epoch-millisecond timestamp of the last network sync, used for staleness checks.
 */
@Entity(tableName = "routes")
data class RouteEntity(
    @PrimaryKey val id: String,
    val title: String,
    val travelMode: String,
    val userActive: Boolean,
    val arriveByMinutes: Int,
    val activeDaysJson: String,
    val timeZoneId: String,
    val originPlaceId: String,
    val originLabel: String,
    val destinationPlaceId: String,
    val destinationLabel: String,
    val cachedAt: Long
)
